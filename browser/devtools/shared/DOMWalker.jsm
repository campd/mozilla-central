const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/devtools/EventEmitter.jsm");
Cu.import("resource://gre/modules/devtools/dbg-actor-helpers.jsm")

var { types, params, remotable } = Remotable;

let obj = {};
Cu.import('resource://gre/modules/commonjs/loader.js', obj);
let {Loader, Require, unload} = obj.Loader;
let loader = new Loader({
  paths: {
    'commonjs/': 'resource://gre/modules/commonjs/',
    '': 'resource:///modules/',
  }
});
let require = Require(loader, {id: "markupview"});

let promise = require("commonjs/promise/core");

this.EXPORTED_SYMBOLS = ["DOMWalker", "DOMWalkerActor", "createWalker"];

this.createWalker = function(target, options) {
  if (target.window) {
    return new DOMWalker(target.window.document, options);
  }
  if (target.client) {
    return new RemoteWalker(target, options);
  }
};

/**
 * Remotable types specific to the DOM walker.
 */

var domTypes = {};
domTypes.Node = new types.Context("nodeToProtocol", "nodeFromProtocol");
domTypes.Nodes = new types.Array(domTypes.Node);

domTypes.PseudoModification = new types.Context(
  "pseudoModificationToProtocol",
  "pseudoModificationFromProtocol"
);
domTypes.PseudoModifications = new types.Array(domTypes.PseudoModification);


var domParams = {};
domParams.Node = function(path) {
  return new Remotable.Param(path, domTypes.Node);
};
domParams.Nodes = function(path) {
  return new Remotable.Param(path, domTypes.Nodes);
};
domParams.PseudoModifications = function(path) {
  return new Remotable.Param(path, domTypes.PseudoModifications);
};

// Some custom params/returns for this file.
domParams.LongNodeListOptions = params.Complex([
  params.Simple("maxNodes"),
  params.Simple("whatToShow"),
  domParams.Node("include")
]);

domParams.LongNodeList = params.Complex([
  params.Simple("hasFirst"),
  params.Simple("hasLast"),
  domParams.Nodes("nodes")
]);


function DOMRef(node) {
  this._rawNode = node;
}

DOMRef.prototype = {
  toString: function() {
    return "[DOMRef for " + this._rawNode.toString() + "]";
  },

  /**
   * The local dom node represented by this node.  If you
   * use this node, you won't be remote-protocol safe.
   */
  get rawNode() this._rawNode,

  /**
   * XXX: don't use this.
   */
  get parentKey() documentWalker(this._rawNode).parentNode(),

  get id() this._rawNode.id,
  get className() this._rawNode.className,

  get hasChildren() !!this._rawNode.firstChild,
  get numChildren() this._rawNode.childNodes.length,
  get nodeType() this._rawNode.nodeType,

  get namespaceURI() this._rawNode.namespaceURI,
  get tagName() this._rawNode.tagName,
  get nodeName() this._rawNode.nodeName,

  get nodeValue() this._rawNode.nodeValue,
  setNodeValue: function(aValue) {
    this._rawNode.nodeValue = aValue;
    return promise.resolve(undefined);
  },

  isWalkerRoot: function() {
    return !(documentWalker(this._rawNode).parentNode());
  },

  isDocumentElement: function() {
    return this._rawNode == nodeDocument(this._rawNode).documentElement;
  },

  isNode: function() {
    let node = this._rawNode;
    return (node &&
            nodeDocument(node) &&
            nodeDocument(node).defaultView &&
            node instanceof nodeDocument(node).defaultView.Node);
  },

  isConnected: function() {
    try {
      let doc = nodeDocument(this._rawNode);
      return doc && doc.defaultView && doc.documentElement.contains(this._rawNode);
    } catch (e) {
      // "can't access dead object" error
      return false;
    }
  },

  getAttribute: function(attr) this._rawNode.getAttribute(attr),

  get attributes() this._rawNode.attributes,

  get classList() new ClassListRef(this._rawNode.classList),

  // doctype attributes
  get name() this._rawNode.name,
  get publicId() this._rawNode.publicId,
  get systemId() this._rawNode.systemId,

  // This means we need to send a change notification for pseudo-class locks.
  hasPseudoClassLock: function(pseudo) DOMUtils.hasPseudoClassLock(this._rawNode, pseudo),

  // XXX: we should just add a DOMUtils.activePseudoClassLocks() or something.
  _pseudoClasses: null,
  get pseudoClassLocks() {
    return this._pseudoClasses ? Object.getOwnPropertyNames(this._pseudoClasses) : null;
  },
};

// XXX: yuck, this should just be a proxy.
function ClassListRef(aList)
{
  this._classList = aList;
  for (let i = 0; i < aList.length; i++) {
    this[i] = aList[i];
  }
  this.length = aList.i;
}

ClassListRef.prototype = {
  contains: function(cls) this._classList.contains(cls),
};

/**
 * An async DOM walker.
 */
this.DOMWalker = function DOMWalker(document, options)
{
  EventEmitter.decorate(this);
  this._doc = document;
  this._refMap = new WeakMap();

  if (!!options.watchVisited) {
    this._observer = new document.defaultView.MutationObserver(this._mutationObserver.bind(this));
    this._contentLoadedListener = function DW_contentLoaded(aEvent) {
      // Fake a childList mutation here.
      this._mutationObserver([{target: aEvent.target, type: "childList"}]);
    }.bind(this);
    document.addEventListener("load", this._contentLoadedListener, true);
  }

  // pseudo-class lock implementation details.
  this._pclList = [];
}

DOMWalker.prototype = {
  destroy: function() {
    if (this._observer) {
      this._observer.disconnect();
      delete this._observer;
    }

    if (this._contentLoadedListener) {
      this._doc.removeEventListener("load", this._contentLoadedListener, true);
      delete this._contentLoadedListener;
    }

    delete this._refMap;
    delete this._doc;

    this.clearPseudoClassLocks(null, { all: true });
    delete this._pclList;
  },

  /**
   * Return the document node that contains the given node,
   * or the root node if no node is specified.
   * @param NodeRef aNode
   *        The node whose document is needed, or null to
   *        return the root.
   */
  document: remotable(function(aNode) {
    let doc = aNode ? aNode._rawNode.ownerDocument : this._doc;
    return promise.resolve(this._ref(doc));
  }, {
    params: [domParams.Node("node")],
    ret: domParams.Node("node"),
  }),

  /**
   * Return the documentElement for the document containing the
   * given node.
   * @param NodeRef aNode
   *        The node whose documentElement is requested, or null
   *        to use the root document.
   */
  documentElement: remotable(function(aNode) {
    let elt = aNode ? aNode._rawNode.ownerDocument.documentElement : this._doc.documentElement;
    return promise.resolve(this._ref(elt));
  }, {
    params: [domParams.Node("node")],
    ret: domParams.Node("node"),
  }),

  parents: remotable(function(node) {
    let walker = documentWalker(node._rawNode);
    let parents = [];
    let cur;
    while(cur = walker.parentNode()) {
      parents.push(this._ref(cur));
    }
    return promise.resolve(parents);
  }, {
    params: [domParams.Node("node")],
    ret: domParams.Nodes("nodes"),
  }),

  children: remotable(function(node, options={}) {
    let maxNodes = options.maxNodes || -1;
    if (maxNodes == -1) {
      maxNodes = Number.MAX_VALUE;
    }

    let rawNode = node._rawNode;
    let show = options.whatToShow || Ci.nsIDOMNodeFilter.SHOW_ALL;

    let firstChild = documentWalker(rawNode, show).firstChild();
    let lastChild = documentWalker(rawNode, show).lastChild();

    if (!firstChild) {
      // No children, we're done.
      return promise.resolve({ hasFirst: true, hasLast: true, nodes: [] });
    }

    // By default try to put the selected child in the middle of the list.
    let start = firstChild;
    if (options.include) {
      start = options.include._rawNode;
    }

    // Start by reading backward from the starting point....
    let nodes = [];
    let backwardWalker = documentWalker(start, show);
    if (start != firstChild) {
      backwardWalker.previousSibling();
      let backwardCount = Math.floor(maxNodes / 2);
      let backwardNodes = this._readBackward(backwardWalker, backwardCount);
      nodes = backwardNodes;
    }

    // Then read forward by any slack left in the max children...
    let forwardWalker = documentWalker(start, show);
    let forwardCount = maxNodes - nodes.length;
    nodes = nodes.concat(this._readForward(forwardWalker, forwardCount));

    // If there's any room left, it means we've run all the way to the end.
    // In that case, there might still be more items at the front.
    let remaining = maxNodes - nodes.length;
    if (remaining > 0 && nodes[0]._rawNode != firstChild) {
      let firstNodes = this._readBackward(backwardWalker, remaining);

      // Then put it all back together.
      nodes = firstNodes.concat(nodes);
    }

    return promise.resolve({
      hasFirst: nodes[0]._rawNode == firstChild,
      hasLast: nodes[nodes.length - 1]._rawNode == lastChild,
      nodes: nodes
    });
  }, {
    params: [
      domParams.Node("node"),
      domParams.LongNodeListOptions,
    ],
    ret: domParams.LongNodeList
  }),

  siblings: remotable(function(node, options={}) {
    let parentNode = documentWalker(node.rawNode).parentNode();
    if (!parentNode) {
      return promise.resolve({
        hasFirst: true,
        hasLast: true,
        nodes: [node]
      });
    }

    options.include = node;

    return this.children(this._ref(parentNode), options).then(function(children) {
      return children;
    }).then(promisePass, promiseError);
  }, {
    params: [
      domParams.Node("node"),
      domParams.LongNodeListOptions,
    ],
    ret: domParams.LongNodeList
  }),

  nextSibling: function(node, options={}) {
    let walker = documentWalker(node._rawNode, options.whatToShow || Ci.nsIDOMNodeFilter.SHOW_ALL);
    return promise.resolve(this._ref(walker.nextSibling()));
  },

  previousSibling: function(node, options={}) {
    let walker = documentWalker(node._rawNode, options.whatToShow || Ci.nsIDOMNodeFilter.SHOW_ALL);
    return promise.resolve(this._ref(walker.previousSibling()));
  },

  _readForward: function MV__readForward(aWalker, aCount)
  {
    let ret = [];
    let node = aWalker.currentNode;
    do {
      ret.push(this._ref(node));
      node = aWalker.nextSibling();
    } while (node && --aCount);
    return ret;
  },

  _readBackward: function MV__readBackward(aWalker, aCount)
  {
    let ret = [];
    let node = aWalker.currentNode;
    do {
      ret.push(this._ref(node));
      node = aWalker.previousSibling();
    } while(node && --aCount);
    ret.reverse();
    return ret;
  },

  innerHTML: function(node) {
    return promise.resolve(node._rawNode.innerHTML);
  },

  outerHTML: function(node) {
    return promise.resolve(node._rawNode.outerHTML);
  },

  _addPseudoClassLock: function(node, pseudo) {
    let deferred = promise.defer();
    if (node.nodeType != Ci.nsIDOMNode.ELEMENT_NODE) {
      return;
    }

    if (!node._pseudoClasses) {
      node._pseudoClasses = {};
      this._pclList.push(node);
    }
    node._pseudoClasses[pseudo] = true;
    DOMUtils.addPseudoClassLock(node._rawNode, pseudo);
  },

  addPseudoClassLock: remotable(function(node, pseudo, options={}) {
    this._addPseudoClassLock(node, pseudo);

    if (!options.parents) {
      return promise.resolve(undefined);
    }

    return this.parents(node).then(function(parents) {
      let modified = [node];
      for (let parent of parents) {
        this._addPseudoClassLock(parent, pseudo);
        modified.push(parent);
      }
      return modified;
    }.bind(this));
  }, {
    params: [
      domParams.Node("node"),
      params.Simple("pseudo"),
      params.Complex([
        params.Simple("parents")
      ])
    ],
    ret: domParams.PseudoModifications("modified")
  }),

  _removePseudoClassLock: function(node, pseudo) {
    if (node.nodeType != Ci.nsIDOMNode.ELEMENT_NODE) {
      return;
    }

    if (node._pseudoClasses) {
      delete node._pseudoClasses[pseudo];
      if (Object.getOwnPropertyNames(node._pseudoClasses).length == 0) {
        this._pclList = this._pclList.filter(function(n) n != node);
      }
    }
    DOMUtils.removePseudoClassLock(node._rawNode, pseudo);
  },

  removePseudoClassLock: remotable(function(node, pseudo, options={}) {
    this._removePseudoClassLock(node, pseudo);

    if (!options.parents) {
      return promise.resolve(undefined);
    }

    return this.parents(node).then(function(parents) {
      let modified = [node];
      for (let parent of parents) {
        this._removePseudoClassLock(parent, pseudo);
        modified.push(parent);
      }
      return modified;
    }.bind(this));
  }, {
    params: [
      domParams.Node("node"),
      params.Simple("pseudo"),
      params.Complex([
        params.Simple("parents")
      ])
    ],
    ret: domParams.PseudoModifications("modified")
  }),

  clearPseudoClassLocks: remotable(function(node, options={}) {
    let modified = [];
    if (node) {
      DOMUtils.clearPseudoClassLocks(node._rawNode);
      node._pseudoClasses = null;
      this._pclList = this._pclList.filter(function(n) n != node);
      modified.push(node);
    }
    if (options.all) {
      modified = modified.concat(this._pclList);
      for (let lockedNode of this._pclList) {
        DOMUtils.clearPseudoClassLocks(lockedNode._rawNode);
        lockedNode._pseudoClasses = null;
        modified.push(lockedNode);
      }
      this._pclList = [];
    }
    return promise.resolve(modified);
  }, {
    params: [
      domParams.Node("node"),
      params.Complex([
        params.Simple("all")
      ])
    ],
    ret: domParams.PseudoModifications("modified")
  }),

  /**
   * Get a DOMRef for the given local node.
   * Using this method is not remote-protocol safe.
   */
  importRaw: function(node) {
    let nodeRef = this._ref(node);
    // Ensure all parents have been imported too, since that will be true
    // in the remote case (?)
    this.parents(nodeRef).then(null, null);
    return nodeRef;
  },

  _ref: function(node) {
    if (this._refMap.has(node)) {
      return this._refMap.get(node);
    }
    let ref = new DOMRef(node);

    if (this._observer) {
      this._observer.observe(node, {
        attributes: true,
        childList: true,
        characterData: true,
      });
    }

    // FIXME: set an expando to prevent the the wrapper from disappearing
    node.__preserveHack = true;

    this._refMap.set(node, ref);
    return ref;
  },

  _mutationObserver: function(mutations)
  {
    let refMutations = [];
    for (let change of mutations) {
      if (!this._refMap.get(change.target)) {
        continue;
      }
      refMutations.push({
        type: change.type,
        target: this._refMap.get(change.target),
        attributeName: change.attributeName || undefined,
        attributeNamespace: change.attributeNamespace || undefined,
        oldValue: change.oldValue || undefined
      });
    }
    this.emit("mutations", refMutations);
  }
};

Remotable.initImplementation(DOMWalker.prototype);

function RemoteRef(walker, form)
{
  this.walker = walker;
  this.actorID = form.actor;

  this._updateForm(form);
}

RemoteRef.prototype = {
  toString: function() "[RemoteRef to " + this.actorID + "]",

  get id() this.form_id,
  get className() this.form_className,

  get hasChildren() this.form_numChildren > 0,
  get numChildren() this.form_numChildren,
  get nodeType() this.form_nodeType,

  get namespaceURI() this.form_namespaceURI,
  get tagName() this.form_tagName,
  get nodeName() this.form_nodeName,
  get nodeValue() this.form_nodeValue,

  setNodeValue: function(aValue) {
    return this.walker.rawRequest({
      to: this.actorID,
      type: "setNodeValue",
      value: aValue
    });
  },

  isWalkerRoot: function() !!this.form_isWalkerRoot,

  isDocumentElement: function() this.form_isDocumentElement,

  isNode: function() this.form_isNode,

  isConnected: function() this.form_isConnected,

  _getAttribute: function(name) {
    if (!this._attrMap) {
      this._attrMap = {};
      for (let attr of this.form_attrs) {
        this._attrMap[attr.name] = attr;
      }
    }
    return this._attrMap[name];
  },

  getAttribute: function(name) {
    let attr = this._getAttribute(name);
    return attr ? attr.value : null;
  },

  get attributes() this.form_attrs,

  get classList() [],

  // doctype attributes
  get name() this.form_name,
  get publicId() this.form_publicId,
  get systemId() this.form_systemId,

  hasPseudoClassLock: function(pseudo) {
    if (!this.form_pseudoClassLocks) {
      return false;
    }
    if (!this._lockMap) {
      this._lockMap = new Map();
      for (let lock of this.form_pseudoClassLocks) {
        this._lockMap.set(lock);
      }
    }
    return this._lockMap.has(pseudo);
  },

  _updateForm: function(form) {
    for (let name of Object.getOwnPropertyNames(form)) {
      this["form_" + name] = form[name];
      if (name == 'attrs') {
        delete this._attrMap;
      } else if (name == "pseudoClassLocks") {
        delete this._lockMap;
      }
    }
  },

  _updateLocks: function(lock) {
    delete this._lockMap;
    this.form_pseudoClassLocks = lock.pseudoClassLocks;
  },

  _updateMutation: function(mutation) {
    if (mutation.type == "attributes") {
      if (mutation.newValue === null) {
        // XXX: get attribute namespace right.
        this.form_attrs = this._form_attrs.filter(function (a) a.name != mutation.attributeName);
        delete this._attrMap[mutation.attributeName];
      } else {
        let attr = this._getAttribute(mutation.attributeName);
        if (attr) {
          attr.value = mutation.newValue;
        } else {
          let attr = {
            name: mutation.attributeName,
            namespaceURI: mutation.attributeNamespace || undefined,
            value: mutation.newValue
          };
          this._attrMap[mutation.attributeName] = attr;
          this.form_attrs.push(attr);
        }
      }
    } else if (mutation.type == "characterData") {
      this.form_nodeValue = mutation.newValue;
    }
  }
};

function RemoteWalker(target, options)
{
  EventEmitter.decorate(this);
  Remotable.initClient(RemoteWalker.prototype, DOMWalker.prototype);

  this.client = target.client;

  this._refMap = new Map();
  this._boundOnMutations = this._onMutations.bind(this);
  this.client.addListener("mutations", this._boundOnMutations);

  // Start fetching an actor to back the options.
  this.actorPromise = this.rawRequest({
    to: target.form.inspectorActor,
    type: "getWalker"
  }).then(function(response) {
    this._actor = response.actor;
    return this._actor;
  }.bind(this)).then(promisePass, promiseError);

  this.options = options;
}

RemoteWalker.prototype = {
  destroy: function() {
    // XXX: disconnect the actor.
    this.client.removeListener("mutations", this._boundOnMutations);
    delete this._boundOnMutations;
  },

  nodeToProtocol: function(node) node ? node.actorID : node,
  nodeFromProtocol: function(form) form ? this._ref(form) : form,

  pseudoModificationFromProtocol: function(modified) {
    let ref = this._refForActor(modified.actor);
    if (ref) {
      ref._updateLocks(modified);
    }
    return ref;
  },

  _ref: function(form) {
    if (this._refMap.has(form.actor)) {
      return this._refMap.get(form.actor);
    }

    let ref = new RemoteRef(this, form);
    this._refMap.set(form.actor, ref)
    return ref;
  },

  _refForActor: function(actor) {
    if (this._refMap.has(actor)) {
      return this._refMap.get(actor);
    }
    return null;
  },

  _onMutations: function(aType, aPacket) {
    if (aPacket.from != this._actor) {
      return;
    }

    let toEmit = [];

    for (let mutation of aPacket.mutations) {
      let localRef = this._refMap.get(mutation.target);
      localRef._updateMutation(mutation);
      // XXX; I don't like how often we have to repeat these things :/
      toEmit.push({
        target: localRef,
        type: mutation.type,
        attributeName: mutation.attributeName || undefined,
        attributeNamespace: mutation.attributeNamespace || undefined,
        oldValue: mutation.oldValue || undefined,
      });
    }
    this.emit("mutations", toEmit);
  },

  actor: function() {
    return this.actorPromise;
  },
};

/**
 * Server-side actor implementation.
 */
this.DOMWalkerActor = function DOMWalkerActor(aParentActor, aWalker)
{
  Remotable.initServer(DOMWalkerActor.prototype, DOMWalker.prototype);

  this.conn = aParentActor.conn;
  this.parent = aParentActor;
  this._nodePool = new DOMNodePool(this);
  this.conn.addActorPool(this._nodePool);
  this.impl = aWalker;

  this._boundOnMutations = this._onMutations.bind(this);
  this.impl.on("mutations", this._boundOnMutations);
}

DOMWalkerActor.prototype = {
  actorPrefix: "domwalker",
  grip: function DWA_grip()
  {
    return { actor: this.actorID };
  },

  toString: function() {
    return "[DOMWalkerActor " + this.actorID + "]";
  },

  disconnect: function DWA_disconnect()
  {
    this.imple.off("mutations", this._boundOnMutations);
    delete this._boundOnMutations;

    this.impl.destroy();

    this.conn.removeActorPool(this._nodePool);
    delete this._nodePool;
    this.parent.releaseActor(this);
    delete this.conn;
    delete this.parent;
  },

  nodeToProtocol: function DWA_nodeToProtocol(node) {
    return this._nodePool.fromNode(node).form();
  },
  nodeFromProtocol: function DWA_nodeFromProtocol(node) {
    return this._nodePool.node(node);
  },

  pseudoModificationToProtocol: function(node) {
    let actor = this._nodePool.nodeActor(node);
    return {
      actor: actor,
      pseudoClassLocks: node.pseudoClassLocks
    }
  },

  _onMutations: function DWA_onMutations(event, mutations)
  {
    let toSend = [];
    for (let mutation of mutations) {
      if (!mutation.target.__actorID) {
        // This isn't a node we're monitoring.
        continue;
      }
      let target = mutation.target.__actorID;
      if (mutation.type == "childList") {
        toSend.push({
          target: target,
          type: "childList",
        });
      } else if (mutation.type == "attributes") {
        toSend.push({
          target: target,
          type: "attributes",
          attributeName: mutation.attributeName,
          attributeNamespace: mutation.attributeNamespace,
          oldValue: mutation.oldValue,
          newValue: mutation.target.rawNode.getAttribute(mutation.attributeName)
        });
      } else if (mutation.type == "characterData") {
        toSend.push({
          target: target,
          type: "characterData",
          newValue: mutation.target.nodeValue,
        });
      }
    }

    this.conn.send({
      from: this.actorID,
      type: "mutations",
      mutations: toSend
    });
  },

  sendError: function(error) {
    this.conn.send({
      from: this.actorID,
      error: "inspectorError",
      message: "DOM walker error:" + error.toString()
    })
  },
};

// These are ephemeral, created as needed by the DOMWalkerNodePool.
function DOMNodeActor(aConn, aNodeRef)
{
  this.conn = aConn;
  this.nodeRef = aNodeRef;
  this.actorID = aNodeRef.__actorID;
}

DOMNodeActor.prototype = {
  form: function DNA_form() {
    let form = {
      actor: this.actorID
    };

    // XXX: some of these are redundant and should be worked out independently
    // on the client.

    for (let attr of [
      "id", "className", "numChildren",
      "nodeType", "namespaceURI", "tagName", "nodeName", "nodeValue",
      "name", "publicId", "systemId", "pseudoClassLocks"]) {
      form[attr] = this.nodeRef[attr];
    }

    for (let attr of [
      "isDocumentElement", "isNode", "isConnected"]) {
      form[attr] = this.nodeRef[attr]();
    }

    if (this.nodeRef.attributes) {
      let attrs = [];
      for (let i = 0; i < this.nodeRef.attributes.length; i++) {
        let attr = this.nodeRef.attributes[i];
        // XXX: namespace?
        attrs.push({name: attr.name, value: attr.value });
      }
      form.attrs = attrs;
    }

    if (this.nodeRef.isWalkerRoot()) {
      form.isWalkerRoot = true;
    }

    return form;
  },

  onSetNodeValue: function DNA_onSetNodeValue(aPacket) {
    this.nodeRef.setNodeValue(aPacket.value);
    this.conn.send({
      from: this.actorID,
    });
  },
}

DOMNodeActor.prototype.requestTypes = {
  setNodeValue: DOMNodeActor.prototype.onSetNodeValue,
};

/**
 * Keeps track of the actor IDs we handed out and creates DOMNodeActors
 * as needed.
 */
function DOMNodePool(aActor) {
  this.walkerActor = aActor;
  this.idMap = new Map();
  // XXX: maybe we should just use this.conn.allocID...
  this.currentID = 0;
}

DOMNodePool.prototype = {
  fromNode: function(aNodeRef)  {
    if (!aNodeRef.__actorID) {
      aNodeRef.__actorID = this.walkerActor.actorID + "." + this.currentID++;
      this.idMap.set(aNodeRef.__actorID, aNodeRef);
    }

    return new DOMNodeActor(this.walkerActor.conn, aNodeRef)
  },

  nodeActor: function(aNodeRef) aNodeRef.__actorID || this.fromNode(aNodeRef).actorID,

  node: function DNP_node(aActorID) this.idMap.get(aActorID),

  has: function DNP_has(aActorID) this.idMap.has(aActorID),

  get: function DNP_get(aActorID) {
    return new DOMNodeActor(this.walkerActor.conn, this.idMap.get(aActorID));
  },

  isEmpty: function DNP_isEmpty() this.idMap.size == 0,

  cleanup: function DNP_cleanup() {
    this.idMap.clear();
  },
};


function promisePass(r) {
  return r;
}
function promiseError(ex) {
  dump(ex + "\n");
  dump(ex.stack);
//  Services.console.logStringMessage(ex);
  return ex;
}

function documentWalker(node, whatToShow=Ci.nsIDOMNodeFilter.SHOW_ALL) {
  return new DocumentWalker(node, whatToShow, whitespaceTextFilter, false);
}

function nodeDocument(node) {
  return node.ownerDocument || (node.nodeType == Ci.nsIDOMNode.DOCUMENT_NODE ? node : null);
}

/**
 * Similar to a TreeWalker, except will dig in to iframes and it doesn't
 * implement the good methods like previousNode and nextNode.
 *
 * See TreeWalker documentation for explanations of the methods.
 */
function DocumentWalker(aNode, aShow, aFilter, aExpandEntityReferences)
{
  let doc = nodeDocument(aNode);
  this.walker = doc.createTreeWalker(nodeDocument(aNode),
    aShow, aFilter, aExpandEntityReferences);
  this.walker.currentNode = aNode;
  this.filter = aFilter;
}

DocumentWalker.prototype = {
  get node() this.walker.node,
  get whatToShow() this.walker.whatToShow,
  get expandEntityReferences() this.walker.expandEntityReferences,
  get currentNode() this.walker.currentNode,
  set currentNode(aVal) this.walker.currentNode = aVal,

  /**
   * Called when the new node is in a different document than
   * the current node, creates a new treewalker for the document we've
   * run in to.
   */
  _reparentWalker: function DW_reparentWalker(aNewNode) {
    if (!aNewNode) {
      return null;
    }
    let doc = nodeDocument(aNewNode);
    let walker = doc.createTreeWalker(doc,
      this.whatToShow, this.filter, this.expandEntityReferences);
    walker.currentNode = aNewNode;
    this.walker = walker;
    return aNewNode;
  },

  parentNode: function DW_parentNode()
  {
    let currentNode = this.walker.currentNode;
    let parentNode = this.walker.parentNode();

    if (!parentNode) {
      if (currentNode && currentNode.nodeType == Ci.nsIDOMNode.DOCUMENT_NODE
          && currentNode.defaultView) {
        let embeddingFrame = currentNode.defaultView.frameElement;
        if (embeddingFrame) {
          return this._reparentWalker(embeddingFrame);
        }
      }
      return null;
    }

    return parentNode;
  },

  firstChild: function DW_firstChild()
  {
    let node = this.walker.currentNode;
    if (!node)
      return;
    if (node.contentDocument) {
      return this._reparentWalker(node.contentDocument);
    } else if (node instanceof nodeDocument(node).defaultView.GetSVGDocument) {
      return this._reparentWalker(node.getSVGDocument());
    }
    return this.walker.firstChild();
  },

  lastChild: function DW_lastChild()
  {
    let node = this.walker.currentNode;
    if (!node)
      return;
    if (node.contentDocument) {
      return this._reparentWalker(node.contentDocument);
    } else if (node instanceof nodeDocument(node).defaultView.GetSVGDocument) {
      return this._reparentWalker(node.getSVGDocument());
    }
    return this.walker.lastChild();
  },

  previousSibling: function DW_previousSibling() this.walker.previousSibling(),
  nextSibling: function DW_nextSibling() this.walker.nextSibling(),

  // XXX bug 785143: not doing previousNode or nextNode, which would sure be useful.
}

/**
 * A tree walker filter for avoiding empty whitespace text nodes.
 */
function whitespaceTextFilter(aNode)
{
    if (aNode.nodeType == Ci.nsIDOMNode.TEXT_NODE &&
        !/[^\s]/.exec(aNode.nodeValue)) {
      return Ci.nsIDOMNodeFilter.FILTER_SKIP;
    } else {
      return Ci.nsIDOMNodeFilter.FILTER_ACCEPT;
    }
}

XPCOMUtils.defineLazyGetter(this, "DOMUtils", function () {
  return Cc["@mozilla.org/inspector/dom-utils;1"].getService(Ci.inIDOMUtils);
});
