const Cu = Components.utils;

Cu.import("resource://gre/modules/commonjs/promise/core.js");
const promise = Promise;

this.EXPORTED_SYMBOLS = ["Remotable"];

this.Remotable = {};

Remotable.types = {}

Remotable.types.Simple = {
  toProtocol: function(value) value,
  fromProtocol: function(value) value
};

/**
 * The context type constructor builds a type whose interpretation
 * depends on the object asking for the conversion.  Use this to allow
 * server or client objects to provide translation methods.
 *
 * @param string toMethod
 *        Will be called on the context object when sending objects
 *        over the protocol.
 * @param string fromMethod
 *        Will be called on the context object when receiving objects
 *        from the protocol.
 */
Remotable.types.Context = function(toMethod, fromMethod) {
  this.toMethod = toMethod;
  this.fromMethod = fromMethod;
};

Remotable.types.Context.prototype = {
  toProtocol: function(value, context) context[this.toMethod].call(context, value),
  fromProtocol: function(value, context) context[this.fromMethod].call(context, value)
};

/**
 * Represents an array of types.
 *
 * @param Type subtype
 */
Remotable.types.Array = function(subtype) {
  this.subtype = subtype;
};
Remotable.types.Array.prototype = {
  toProtocol: function(value, context) {
    return [this.subtype.toProtocol(item, context) for (item of value)];
  },
  fromProtocol: function(value, context) {
    return [this.subtype.fromProtocol(item, context) for (item of value)];
  }
};

Remotable.types.SimpleArray = new Remotable.types.Array(Remotable.types.Simple);

/**
 * A Param is used to describe the layout of a request/response packet,
 * and to build that request/response packet.
 * @param string path
 *        The name this parameter uses in the protocol packet.
 * @param type
 *        A type object used to convert the object for the protocol.
 */
Remotable.Param = function(path, type) {
  this.path = path;
  this.type = type;
}
Remotable.Param.prototype = {
  toProtocol: function(packet, value, context) {
    packet[this.path] = this.type.toProtocol(value, context);
  },
  fromProtocol: function(packet, context) {
    return this.type.fromProtocol(packet[this.path], context);
  }
};

Remotable.params = {};

/**
 * Simply copies an object into the packet, good for fundamental types.
 */
Remotable.params.Simple = function(path) {
  return new Remotable.Param(path, Remotable.types.Simple);
},

/**
 * A Complex param allows the user to specify a set of subparameters
 * that will be added ... blah I can't explain this right now.
 * XXX: This needs a better name.
 */
Remotable.params.Complex = function(subParams) {
  // XXX: allow this as a constructor too...
  let ret = Object.create(Remotable.params.Complex.prototype);
  ret.subParams = subParams;
  return ret;
}

Remotable.params.Complex.prototype = {
  toProtocol: function(packet, value, context) {
    for (let param of this.subParams) {
      if (param.path in value) {
        param.toProtocol(packet, value[param.path], context);
      }
    }
  },
  fromProtocol: function(packet, context) {
    let ret = {};
    for (let param of this.subParams) {
      ret[param.path] = param.fromProtocol(packet, context);
    }
    return ret;
  },
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
 * Initialize an implementation prototype.  Call this
 * method after you've added remotable methods to your prototype.
 */
Remotable.initImplementation = function(proto)
{
  let remoteSpecs = [];
  for (let name of Object.getOwnPropertyNames(proto)) {
    let item = proto[name];
    if (!item._remoteSpec) {
      continue;
    }

    let spec = item._remoteSpec;
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
        param.toProtocol(request, arguments[i], this);
      }
      return this.request(request).then(function(response) {
        return spec.ret.fromProtocol(response, this);
      }.bind(this));
    }
  });
};

Remotable.initServer = function(serverProto, implProto)
{
  if (serverProto.__remoteInitialized) {
    return;
  }
  serverProto.__remoteInitialized = true;
  if (!serverProto.requestTypes) {
    serverProto.requestTypes = {};
  }

  let remoteSpecs = implProto.__remoteSpecs;
  remoteSpecs.forEach(function(spec) {
    let handler = function(aPacket) {
      let args = [];
      for (let param of spec.params) {
        args.push(param.fromProtocol(aPacket, this));
      }
      this.impl[spec.name].apply(this.impl, args).then(function(ret) {
        let response = {
          from: this.actorID
        };
        spec.ret.toProtocol(response, ret, this);
        this.conn.send(response);
      }.bind(this)).then(null, this.sendError.bind(this));
    };

    serverProto.requestTypes[spec.requestType || spec.name] = handler;
  });
}
