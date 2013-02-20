const Cu = Components.utils;

Cu.import("resource://gre/modules/commonjs/sdk/core/promise.js");
const promise = Promise;

this.EXPORTED_SYMBOLS = ["Remotable"];

this.Remotable = {};

let types = {}
Remotable.types = types;

types.Simple = {
  write: function(value) value,
  read: function(value) value
};

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

types.LongString = function(writeMethod) {
  let self = this instanceof types.LongString ?
    this : Object.create(types.LongString.prototype);
  self.writeMethod = writeMethod;
  return self;
}

types.LongString.prototype = {
  write: function(value, context) {
    return context[this.writeMethod].call(context, value);
  },
  read: function(value, context) {
    return new Remotable.LongStringClient(context.client, value);
  }
};

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
  return Remotable.Param(path, types.LongString(writeMethod));
}

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
 * For actors and clients, implements a custom handler for the
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

/**
 * Initialize an implementation prototype.  Call this
 * method after you've added remotable methods to your prototype.
 */
Remotable.initImplementation = function(proto)
{
  let remoteSpecs = [];
  for (let name of Object.getOwnPropertyNames(proto)) {
    let desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc.value || !desc.value._remoteSpec) {
      continue;
    }
    let spec = desc.value._remoteSpec;
    spec.name = name;
    if (!spec.requestType) {
      spec.requestType = name;
    }
    remoteSpecs.push(spec);
  }

  proto.__remoteSpecs = remoteSpecs;
};

function promisedRequest(packet)
{
  let deferred = promise.defer();
  this.client.request(packet, function(response) {
    if (response.error) {
      deferred.reject(response.error);
    } else {
      deferred.resolve(response);
    }
  });
  return deferred.promise;
}

/**
 * Prepare a client object's prototype.
 * Adds 'rawRequest' and 'request' methods to the
 * prototype.
 */
Remotable.initClient = function(clientProto, implProto)
{
  if (clientProto.__remoteInitialized) {
    return;
  }
  clientProto.__remoteInitialized = true;

  if (!clientProto.rawRequest) {
    clientProto.rawRequest = promisedRequest;
  }
  if (!clientProto.request) {
    // If the client has a requestReady() function,
    // it should return a promise that will resolve
    // when requests are ready to be served.
    clientProto.request = function(packet) {
      return this.actor().then(function(actorID) {
        packet.to = actorID;
        return this.rawRequest(packet);
      }.bind(this));
    }
  }

  let remoteSpecs = implProto.__remoteSpecs;
  remoteSpecs.forEach(function(spec) {
    clientProto[spec.name] = function() {
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
};

Remotable.initActor = function(actorProto, implProto)
{
  if (actorProto.__remoteInitialized) {
    return;
  }
  actorProto.__remoteInitialized = true;
  if (!actorProto.requestTypes) {
    actorProto.requestTypes = {};
  }

  if (!actorProto.writeError) {
    actorProto.writeError = function(err) {
      this.conn.send({
        from: this.actorID,
        error: "unknownError",
        message: err.toString()
      });
      if (err.stack) {
        dump(err.stack);
      }
    };
  }

  implProto = implProto || actorProto;

  let remoteSpecs = implProto.__remoteSpecs;
  remoteSpecs.forEach(function(spec) {
    let handler = null;
    let custom = spec.name + "_request";
    if (custom in actorProto) {
      handler = actorProto[custom];
      if (!handler._custom) {
        throw new Error(spec.name + "_request exists but is not marked custom.\n");
      }
    } else {
      handler = function(aPacket) {
        let args = [];
        for (let param of spec.params) {
          args.push(param.read(aPacket, this));
        }

        this.impl[spec.name].apply(this.impl, args).then(function(ret) {
          let response = {
            from: this.actorID
          };
          spec.ret.write(response, ret, this);
          this.conn.send(response);
        }.bind(this)).then(null, this.writeError.bind(this));
      }
    };

    actorProto.requestTypes[spec.requestType || spec.name] = handler;
  });
}

Remotable.LongString = function(str)
{
  Remotable.initImplementation(Remotable.LongString.prototype);
  this.str = str;
}

Remotable.LongString.INITIAL_SIZE = 1000;
Remotable.LongString.READ_SIZE = 1000;

Remotable.LongString.prototype = {
  get initial() {
    return this.str.substring(0, Remotable.LongString.INITIAL_SIZE);
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
  }, {
    params: [],
    ret: params.Void
  })
}

Remotable.LongStringClient = function(client, form)
{
  Remotable.initClient(Remotable.LongStringClient.prototype, Remotable.LongString.prototype);
  this.client = client;
  this.initial = form.initial;
  this.length = form.length;
  this.actorID = form.actor;
}

Remotable.LongStringClient.prototype = {
  actor: function() promise.resolve(this.actorID),
  string: function() {
    let deferred = promise.defer();
    let start = this.initial.length;
    let chunks = [this.initial];

    let readChunk = function() {
      let end = start + (Math.min(Remotable.LongString.READ_SIZE, this.length - start));
      this.substring(start, end).then(function(chunk) {
        chunks.push(chunk);
        if (end === this.length) {
          deferred.resolve(chunks.join(""));
          return;
        }
        start = end;
        dump("length is " + this.length + "\n");
        readChunk();
      }.bind(this), function(error) {
        deferred.reject(error);
      });
    }.bind(this);

    readChunk();

    return deferred.promise;
  },
};

Remotable.LongStringActor = function(pool, actorID, impl)
{
  let self = this instanceof Remotable.LongStringActor ?
    this : Object.create(Remotable.LongStringActor.prototype);
  Remotable.initActor(Remotable.LongStringActor.prototype,
                      Remotable.LongString.prototype);
  self.conn = pool.conn;
  self.pool = pool;
  self.actorID = actorID;
  self.impl = impl;
  return self;
}

Remotable.LongStringActor.prototype = {
  form: function() {
    if (this.impl.length < Remotable.LongString.INITIAL_SIZE) {
      return this.impl.str;
    }

    return {
      type: "longString",
      actor: this.actorID,
      initial: this.impl.initial,
      length: this.impl.length,
    }
  },

  release_request: Remotable.custom(function(aPacket) {
    this.impl.release();
    this.pool.remove(this.actorID);
    return {from: this.actorID};
  }),
};

/**
 * An actor pool that dynamically creates actor objects as needed
 * based on the underlying implementation.
 */
Remotable.WrapperPool = function(conn, prefix, factory, context)
{
  this.conn = conn;
  this.prefix = prefix;
  this.factory = factory;
  this.context = context;
  this.map = new Map();
}

Remotable.WrapperPool.prototype = {
  add: function(obj) {
    if (!obj.__actorID) {
      obj.__actorID = this.conn.allocID(this.prefix || undefined);
    }
    this.map.set(obj.__actorID, obj);
    return this.factory(this, obj.__actorID, obj, this.context);
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
  obj: function(actorID) this.map.get(actorID),
  has: function(actorID) this.map.has(actorID),
  get: function(actorID) {
    let obj = this.map.get(actorID);
    return this.factory(this, obj.__actorID, this.map.get(actorID), this.context);
  },
  isEmpty: function() this.map.size == 0,
  cleanup: function() {
    this.map.clear();
  }
}
