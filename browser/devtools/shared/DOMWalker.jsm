const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/devtools/EventEmitter.jsm");


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


this.EXPORTED_SYMBOLS = ["DOMWalker", "createWalker"];

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
  new EventEmitter(this);
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
  this._pclMap = new Map();
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
    delete this._pclMap;
    delete this._pclList;
  },

  root: function() {
    return promise.resolve(this._ref(this._doc));
  },

  parents: function(node, options) {
    let walker = documentWalker(node._rawNode);
    let parents = [];
    let cur;
    while(cur = walker.parentNode()) {
      parents.push(this._ref(cur));
    }
    return promise.resolve(parents);
  },

  children: function(node, options={}) {
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
      return promise.resolve({ hasFirst: true, hasLast: true, children: [] });
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
  },

  siblings: function(node, options={}) {
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
  },

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
    if (node.nodeType != Ci.nsIDOMNode.ELEMENT_NODE) {
      return;
    }

    if (!this._pclMap.has(node)) {
      this._pclMap.set(node, new Set());
      this._pclList.push(node);
    }
    this._pclMap.get(node).add(pseudo);
    DOMUtils.addPseudoClassLock(node._rawNode, pseudo);
  },

  addPseudoClassLock: function(node, pseudo, options={}) {
    this._addPseudoClassLock(node, pseudo);

    if (!options.parents) {
      return promise.resolve(undefined);
    }

    return this.parents(node).then(function(parents) {
      for (let parent of parents) {
        this._addPseudoClassLock(parent, pseudo);
      }
    }.bind(this));
  },

  _removePseudoClassLock: function(node, pseudo) {
    if (node.nodeType != Ci.nsIDOMNode.ELEMENT_NODE) {
      return;
    }

    if (this._pclMap.has(node)) {
      let set = this._pclMap.get(node);
      set.delete(pseudo);
      if (set.size == 0) {
        this._pclMap.delete(node);
        this._pclList = this._pclList.filter(function(n) n != node);
      }
    }
    DOMUtils.removePseudoClassLock(node._rawNode, pseudo);
  },

  removePseudoClassLock: function(node, pseudo, options={}) {
    this._removePseudoClassLock(node, pseudo);

    if (!options.parents) {
      return promise.resolve(undefined);
    }

    return this.parents(node).then(function(parents) {
      for (let parent of parents) {
        this._removePseudoClassLock(parent, pseudo);
      }
    }.bind(this));
  },

  clearPseudoClassLocks: function(node, options={}) {
    if (node) {
      DOMUtils.clearPseudoClassLocks(node._rawNode);
      this._pclMap.delete(node);
      this._pclList = this._pclList.filter(function(n) n != node);
    }
    if (options.all) {
      for (let lockedNode of this._pclList) {
        DOMUtils.clearPseudoClassLocks(lockedNode._rawNode);
      }
      this._pclMap.clear();
      this._pclList = [];
    }
    return promise.resolve(undefined);
  },

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

function RemoteRef(form)
{
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

  hasPseudoClassLock: function(pseudo) false,

  _updateForm: function(form) {
    for (let name of Object.getOwnPropertyNames(form)) {
      this["form_" + name] = form[name];
      if (name == 'attrs') {
        delete this._attrMap;
      }
    }
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
    }
  }
};


function RemoteWalker(target, options)
{
  new EventEmitter(this);

  this.client = target.client;
  this.tabForm = target.form;
  this.options = options;
  this._refMap = new Map();

  this._boundOnMutations = this._onMutations.bind(this);
  this.client.addListener("mutations", this._boundOnMutations);

  this.init();
}

RemoteWalker.prototype = {
  destroy: function() {
    // XXX: disconnect the actor.
    this.client.removeListener("mutations", this._boundOnMutations);
    delete this._boundOnMutations;
  },

  _ref: function(form) {
    if (this._refMap.has(form.actor)) {
      return this._refMap.get(form.actor);
    }

    let ref = new RemoteRef(form);
    this._refMap.set(form.actor, ref)
    return ref;
  },

  _promisedRequest: function(packet) {
    let deferred = promise.defer();
    this.client.request(packet, function(aResponse) {
      if (aResponse.error) {
        deferred.reject(aResponse.error);
      } else {
        deferred.resolve(aResponse);
      }
    });
    return deferred.promise;
  },

  _request: function(packet) {
    return this.init().then(function() {
      packet.to = this._walkerID;
      return this._promisedRequest(packet);
    }.bind(this));
  },

  _onMutations: function(aType, aPacket) {
    if (aPacket.from != this._walkerID) {
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

  init: function() {
    if (this.deferredInit) {
      return this.deferredInit;
    }

    this.deferredInit = this._promisedRequest({
      to: this.tabForm.inspectorActor,
      type: "getWalker"
    }).then(function(response) {
      this._walkerID = response.actor;
      return response;
    }.bind(this)).then(promisePass, promiseError)
    return this.deferredInit;
  },

  root: function() {
    return this._request({ type: "root" }).then(function(response) {
      return this._ref(response.root);
    }.bind(this)).then(promisePass, promiseError)
  },

  children: function(node, options={}) {
    return this._request({
      type: "children",
      node: node.actorID,
      include: options.include ? options.include.actorID : undefined,
      maxNodes: options.maxNodes || undefined,
      whatToShow: options.whatToShow || undefined
    }).then(function(response) {
      return {
        hasFirst: response.hasFirst,
        hasLast: response.hasLast,
        nodes: [this._ref(form) for (form of response.nodes)]
      };
    }.bind(this)).then(promisePass, promiseError);
  },

  siblings: function(node, options={}) {
    return this._request({
      type: "siblings",
      node: node.actorID,
      maxNodes: options.maxNodes || undefined,
      whatToShow: options.whatToShow || undefined
    }).then(function(response) {
      return {
        hasFirst: response.hasFirst,
        hasLast: response.hasLast,
        nodes: [this._ref(form) for (form of response.nodes)]
      };
    }.bind(this)).then(promisePass, promiseError);
  },

  parents: function(node) {
    return this._request({
      type: "parents",
      node: node.actorID
    }).then(function(response) {
      return [this._ref(form) for (form of response.nodes)];
    }.bind(this)).then(promisePass, promiseError);
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

this.createWalker = function(target, options) {
  if (target.document) {
    return new DOMWalker(target.document, options);
  }
  if (target.client) {
    return new RemoteWalker(target, options);
  }
};


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
