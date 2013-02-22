const Cu = Components.utils;

Cu.import("resource://gre/modules/devtools/Loader.jsm");
let require = devtoolsRequire;

let promise = require("sdk/core/promise");
let { Class } = require('sdk/core/heritage');


this.EXPORTED_SYMBOLS = ["Remotable"];

this.Remotable = {};

let types = {}
Remotable.types = types;

types.Simple = {
  write: function(value) value,
  read: function(value) value
};

/**
 * Some synonyms for Simple types for self-documentation purposes.
 * WE could make these do type checking later if we want.
 */
types.Bool = types.Int = types.String = types.Simple;

/**
 * The context type constructor builds a type whose interpretation
 * depends on the object asking for the conversion.  Use this to allow
 * actor or client objects to provide translation methods.
 *
 * @param string writeMethod
 *        Will be called on the context object when writing objects
 *        over the protocol.
 * @param string readMethod
 *        Will be called on the context object when receiving objects
 *        from the protocol.
 */
types.Context = function(writeMethod, readMethod) {
  let self = this instanceof types.Context ?
    this : Object.create(types.Context.prototype);
  self.writeMethod = writeMethod;
  self.readMethod = readMethod;
  return self;
};

types.Context.prototype = {
  write: function(value, context) context[this.writeMethod].call(context, value),
  read: function(value, context) context[this.readMethod].call(context, value)
};


/**
 * Represents an array of types.
 *
 * @param Type subtype
 */
types.Array = function(subtype) {
  let self = this instanceof types.Array ? this : Object.create(types.Array.prototype)
  self.subtype = subtype;
  return self;
};

types.Array.prototype = {
  write: function(value, context) {
    return [this.subtype.write(item, context) for (item of value)];
  },
  read: function(value, context) {
    return [this.subtype.read(item, context) for (item of value)];
  }
};

types.SimpleArray = types.Array(types.Simple);

/**
 * Typed dictionary.  Example:
 * types.Dict({
 *   a: Simple(),
 *   b: Context("write", "read")
 * });
 */
types.Dict = function(subtypes) {
  let self = this instanceof types.Dict ? this : Object.create(types.Dict.prototype);
  self.subtypes = subtypes;
  return self;
}

types.Dict.prototype = {
  write: function(value, context) {
    let ret = {};
    for (let t in this.subtypes) {
      ret[t] = value[t] ? this.subtypes[t].write(value[t], context) : undefined;
    }
    return ret;
  },
  read: function(value, context) {
    let ret = {};
    for (let t in this.subtypes) {
      ret[t] = value[t] ? this.subtypes[t].read(value[t], context) : undefined;
    }
    return ret;
  }
}

types.LongString = {
  write: function(value, context) {
    return value.form();
  },
  read: function(value, context) {
    return new Remotable.LongStringFront(context, value);
  }
};

types.Actor = function(tag, detail) {
  let self = this instanceof types.Actor ? this : Object.create(types.Actor.prototype);
  self.detail = detail;
  self.tag = tag;
  return self;
}

types.Actor.prototype = {
  write: function(value, context) {
    if (!value) return value;
    if (context instanceof Remotable.Actor) {
      return value.form(this.detail);
    } else {
      return value.actorID;
    }
  },
  read: function(value, context) {
    if (!value) return value;

    if (context instanceof Remotable.Actor) {
      return context.pool.obj(value);
    }

    return context.managedFronts[this.tag].call(context, value);
  },
}

/**
 * A Param is used to describe the layout of a request/response packet,
 * and to build that request/response packet.
 * @param string path
 *        The name this parameter uses in the protocol packet.
 * @param type
 *        A type object used to convert the object for the protocol.
 */
Remotable.Param = function(path, type) {
  let self = this instanceof Remotable.Param ?
    this : Object.create(Remotable.Param.prototype);
  self.path = path;
  self.type = type;
  return self;
}
Remotable.Param.prototype = {
  write: function(packet, value, context) {
    packet[this.path] = this.type.write(value, context);
  },
  read: function(packet, context) {
    return this.type.read(packet[this.path], context);
  }
};

let params = {};
Remotable.params = params;

params.Void = function() {
  return {
    write: function() {},
    read: function() {
      return undefined;
    }
  };
};

/**
 * Simply copies an object into the packet, good for fundamental types.
 */
params.Simple = function(path) {
  return Remotable.Param(path, types.Simple);
},

params.SimpleArray = function(path) {
  return Remotable.Param(path, types.SimpleArray);
}

/**
 * An options param allows the user to specify a set of parameters
 * to be uplifted from an object into the packet.
 */
params.Options = function(subParams) {
  let ret = Object.create(params.Options.prototype);
  ret.subParams = subParams;
  return ret;
}

params.Options.prototype = {
  write: function(packet, value, context) {
    for (let param of this.subParams) {
      if (param.path in value) {
        param.write(packet, value[param.path], context);
      }
    }
  },
  read: function(packet, context) {
    let ret = {};
    for (let param of this.subParams) {
      ret[param.path] = param.read(packet, context);
    }
    return ret;
  },
}

params.LongStringReturn = function(path, writeMethod)
{
  return Remotable.Param(path, types.LongString);
}

Remotable.Actor = Class({
  /**
   * Initialize the actor.
   * @param Actor owner
   *   The parent/owner actor.
   */
  initialize: function(owner) {
    this.owner = owner;
    this.actorID = owner.pool.addActor(this);
  },

  destroy: function() {
    delete this.owner;
    delete this.actorID;
  },

  get conn() this.owner ? this.owner.conn : null,

  /**
   * Override this prefix in subclasses to customize actor strings.
   */
  actorPrefix: "actor",

  /**
   * Override this method in subclasses to serialize the actor.
   * @param string
   *    Optional string to customize the form.
   * @returns A jsonable object.
   */
  form: function(hint) {
    return { actor: this.actorID };
  },

  writeError: function(err) {
    dump(err + "\n");
    if (err.stack) {
      dump(err.stack + "\n");
    }
    this.conn.send({
      from: this.actorID,
      error: "unknownError",
      message: err.toString()
    });
  }
});

/**
 * Base class for actors that manage the lifetime of other actors.
 */
Remotable.OwnerActor = Class({
  extends: Remotable.Actor,
  /**
   * Initialize the actor.
   * @param Actor owner
   *   The parent/owner actor.
   */
  initialize: function(owner) {
    let conn = owner ? owner.conn : null;

    this.pool = Remotable.ActorPool(conn, "obj");
    if (conn) {
      conn.addActorPool(this.pool);
    }

    // If no owner was passed in, fake one for now.
    if (!owner) {
      owner = { conn: null, pool: this.pool };
    }

    Remotable.Actor.prototype.initialize.call(this, owner);
  },

  destroy: function() {
    Remotable.Actor.prototype.destroy.call(this);
    if (this.conn) {
      this.conn.removeActorPool(this.pool);
    }

    delete this.pool;
  }
});

/**
 * The remotable function tags a method has a remote implementation.
 * @param function fn
 *        The implementation function, will be returned.
 * @param spec
 *        The remote specification, described elsewhere (assuming I
 *        I finish documenting this before you read this)
 */
Remotable.remotable = function(fn, spec)
{
  fn._remoteSpec = spec;
  return fn;
};

/**
 * For actors, implements a custom handler for the
 * remotable method.  The generated implementation will not be
 * created.
 *
 * @param string internalName
 *   The new name for the generated implementation.
 */
Remotable.custom = function(fn)
{
  fn._custom = true;
  return fn;
}

Remotable.manageActors = function(tag, type, factory)
{
  let impl = function(key) {
    if (!key) return key;
    if (!("_managedActors" in this)) {
      this._managedActors = new Map();
    }
    if (this._managedActors.has(key)) {
      return this._managedActors.get(key);
    }
    let actor = factory ? factory.call(this, key) : new type(this, key);
    this._managedActors.set(key, actor);
    return actor;
  };
  impl._managedActors = tag;
  return impl;
};

Remotable.manageFronts = function(tag, type, factory)
{
  let impl = function(form) {
    if (!form) {
      return form;
    }
    if (!("_managedFronts" in this)) {
      this._managedFronts = {};
    }

    if (form.actor in this._managedFronts) {
      let front = this._managedFronts[form.actor];
      front.form(form);
      return front;
    }

    let front = factory ? factory.call(this, form) : new type(this, form);
    this._managedFronts[form.actor] = front;
    return front;
  };
  impl._managedFronts = tag;
  return impl;
}

/**
 * Initialize an actor prototype.  Call this
 * method after you've added remotable methods to your prototype.
 */
Remotable.initActor = function(actorProto)
{
  actorProto.remoteSpecs = [];
  actorProto.managedActors = [];

  for (let name of Object.getOwnPropertyNames(actorProto)) {
    let desc = Object.getOwnPropertyDescriptor(actorProto, name);
    if (!desc.value) {
      continue;
    }

    if (desc.value._remoteSpec) {
      let spec = desc.value._remoteSpec;
      spec.name = name;
      if (!spec.requestType) {
        spec.requestType = name;
      }
      actorProto.remoteSpecs.push(spec);
    } else if (desc.value._managedActors) {
      actorProto.managedActors.push(desc.value._managedActors);
    }
  }

  actorProto.requestTypes = {};

  actorProto.remoteSpecs.forEach(function(spec) {
    let handler = null;
    let custom = spec.name + "_request";
    if (custom in actorProto) {
      handler = actorProto[custom];
      if (!handler._custom) {
        throw new Error(spec.name + "_request exists but is not marked custom.\n");
      }
    } else {
      handler = function(packet, conn) {
        let args = [];
        for (let param of spec.params) {
          args.push(param.read(packet, this));
        }

        this[spec.name].apply(this, args).then(function(ret) {
          let response = {
            from: this.actorID
          };
          spec.ret.write(response, ret, this);
          conn.send(response);
        }.bind(this)).then(null, this.writeError.bind(this));
      }
    };

    actorProto.requestTypes[spec.requestType || spec.name] = handler;
  });

  return actorProto;
};

/**
 * A client-side object representing an actor.
 */
Remotable.Front = Class({
  initialize: function(owner, form) {
    this.owner = owner;
    if (form) {
      this.actorID = form.actor;
      this.form(form);
    }
  },

  /**
   * Returns a promise that will resolve to the actorID
   * this front represents.
   */
  actor: function() promise.resolve(this.actorID),

  get client() this.owner.client,

  toString: function() "[Remotable.Front for " + this.actorID + "]",

  /**
   * Update the actor from its representation.
   */
  fromForm: function(form) {
    this.actorID = form.actor;
  },

  rawRequest: function(packet) {
    let deferred = promise.defer();
    this.client.request(packet, function(response) {
      if (response.error) {
        deferred.reject(response.error);
      } else {
        deferred.resolve(response);
      }
    });
    return deferred.promise;
  },

  request: function(packet) {
    return this.actor().then(function(actorID) {
      packet.to = actorID;
      return this.rawRequest(packet);
    }.bind(this));
  }
})

function prototypeOf(obj) {
  return typeof(obj) === 'function' ? obj.prototype : obj;
}

/**
 * Prepare a front object's prototype.
 * Adds 'rawRequest' and 'request' methods to the
 * prototype.
 */
Remotable.initFront = function(frontProto)
{
  let actorType = prototypeOf(frontProto.actorType);

  let remoteSpecs = actorType.remoteSpecs;
  remoteSpecs.forEach(function(spec) {
    frontProto[spec.name] = function() {
      let request = {
        type: spec.requestType || spec.name
      };
      for (let i = 0; i < arguments.length; i++) {
        let param = spec.params[i];
        param.write(request, arguments[i], this);
      }
      return this.request(request).then(function(response) {
        return spec.ret.read(response, this);
      }.bind(this));
    }
  });

  frontProto.managedFronts = {};
  for (let name of Object.getOwnPropertyNames(frontProto)) {
    let desc = Object.getOwnPropertyDescriptor(frontProto, name);
    if (!desc.value) {
      continue;
    }

    if (desc.value._managedFronts) {
      frontProto.managedFronts[desc.value._managedFronts] = desc.value;
    }
  }

  return frontProto;
};

Remotable.LONG_STRING_INITIAL_SIZE = 1000;
Remotable.LONG_STRING_READ_SIZE = 1000;

Remotable.LongString = Class(Remotable.initActor({
  extends: Remotable.Actor,

  initialize: function(owner, str) {
    Remotable.Actor.prototype.initialize.call(this, owner);
    this.str = str;
  },

  actorPrefix: "string",

  form: function() {
    if (this.length < Remotable.LONG_STRING_INITIAL_SIZE) {
      return this.str;
    }

    return {
      type: "longString",
      actor: this.actorID,
      initial: this.initial,
      length: this.length,
    }
  },

  get initial() {
    return this.str.substring(0, Remotable.LONG_STRING_INITIAL_SIZE);
  },

  get length() {
    return this.str.length;
  },

  string: function() {
    return promise.resolve(this.str);
  },

  substring: Remotable.remotable(function(start, end) {
    return promise.resolve(this.str.substring(start, end));
  }, {
    params: [
      params.Simple("start"),
      params.Simple("end")
    ],
    ret: params.Simple("substring")
  }),

  release: Remotable.remotable(function() {
    delete this.str;
    this.owner.pool.removeActor(this);
    return promise.resolve(undefined);
  }, {
    params: [],
    ret: params.Void()
  })
}));

Remotable.LongStringFront = Class(Remotable.initFront({
  extends: Remotable.Front,
  actorType: Remotable.LongString,

  initialize: function(owner, form) {
    Remotable.Front.prototype.initialize.call(this, owner, form);
  },

  form: function(form) {
    this.initial = form.initial;
    this.length = form.length;
    this.actorID = form.actor;
  },

  string: function() {
    let deferred = promise.defer();
    let start = this.initial.length;
    let chunks = [this.initial];

    let readChunk = function() {
      let end = start + (Math.min(Remotable.LONG_STRING_READ_SIZE, this.length - start));
      this.substring(start, end).then(function(chunk) {
        chunks.push(chunk);
        if (end === this.length) {
          deferred.resolve(chunks.join(""));
          return;
        }
        start = end;
        readChunk();
      }.bind(this), function(error) {
        deferred.reject(error);
      });
    }.bind(this);

    readChunk();

    return deferred.promise;
  },
}));

var wrapperPoolActorID = 0;
/**
 * An actor pool that dynamically creates actor objects as needed
 * based on the underlying implementation.
 */
Remotable.WrapperPool = function(conn, prefix, factory, context)
{
  let self = this instanceof Remotable.WrapperPool ?
    this : Object.create(Remotable.WrapperPool.prototype);

  self.conn = conn;
  if (conn && conn.allocID) {
    self.allocID = conn.allocID.bind(conn);
  } else {
    // I'm not sure what to do here.  Actor IDs shouldn't matter much
    // in the local/no connection case, so we could just ignore actorID.
    // But someone might be comparing actor ids, so for now we'll try
    // to give it a unique id.
    self.allocID = function() wrapperPoolActorID++;
  }
  self.prefix = prefix;
  self.factory = factory;
  self.context = context;
  self.map = new Map();

  return self;
}

Remotable.WrapperPool.prototype = {
  // Quick compat layer with ActorPool until I can move those to the same
  // place/implementation.
  addActor: function(obj) this.add(obj),
  add: function(obj) {
    if (!obj.__actorID) {
      obj.__actorID = this.allocID(obj.actorPrefix || this.prefix || undefined);
    }
    this.map.set(obj.__actorID, obj);
    return obj.__actorID;
  },
  actorID: function(obj) {
    if (!obj.__actorID) {
      this.add(obj);
    }
    return obj.__actorID;
  },
  remove: function(actorID) {
    this.map.delete(actorID);
  },
  removeActor: function(obj) {
    this.map.delete(obj.__actorID);
  },
  obj: function(actorID) this.map.get(actorID),
  has: function(actorID) this.map.has(actorID),
  get: function(actorID) {
    let obj = this.map.get(actorID);
    return this.factory(this, obj.__actorID, this.map.get(actorID), this.context);
  },
  isEmpty: function() this.map.size == 0,
  cleanup: function() {
    delete this.allocID;
    this.map.clear();
  }
}

Remotable.ActorPool = function(conn, prefix, context) {
  return Remotable.WrapperPool(conn, prefix, function(pool, actorID, obj) obj);
}