const Ci = Components.interfaces;
const Cu = Components.utils;

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
let require = Require(loader, {id: "domwalker"});

let promise = require("commonjs/promise/core");


this.EXPORTED_SYMBOLS = ["DOMWalker"];

function DOMRef(node) {
  this._rawNode = node;
}

DOMRef.prototype = {
  // A key that can be used in a map/weakmap of nodes.
  get key() this._rawNode,
  // The key of the parent node.
  get parentKey() documentWalker(this._rawNode).parentNode(),

  get hasChildren() !!this._rawNode.firstChild,
  get numChildren() this._rawNode.children.length,
  get nodeType() this._rawNode.nodeType,

  get namespaceURI() this._rawNode.namespaceURI,
  get nodeName() this._rawNode.nodeName,
  get nodeValue() this._rawNode.nodeValue,

  get isDocumentElement() this._rawNode != this._rawNode.ownerDocument.documentElement,

  getAttribute: function(attr) this._rawNode.getAttribute(attr),

  get attributes() this._rawNode.attributes,

  // doctype attributes
  get name() this._rawNode.name,
  get publicId() this._rawNode.publicId,
  get systemId() this._rawNode.systemId,
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
}

DOMWalker.prototype = {
  destroy: function() {
    this._observer.disconnect();
    delete this._observer;
    this._doc.removeEventListener("load", this._contentLoadedListener, true);
    delete this._contentLoadedListener;
    delete this._refMap;
  },

  root: function() {
    dump("Document element: " + this._doc.documentElement + "\n");
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
    let maxChildren = options.maxChildren || -1;
    if (maxChildren == -1) {
      maxChildren = Number.MAX_VALUE;
    }

    let rawNode = node._rawNode;

    let firstChild = documentWalker(rawNode).firstChild();
    let lastChild = documentWalker(rawNode).lastChild();

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
    let backwardWalker = documentWalker(start);
    if (start != firstChild) {
      backwardWalker.previousSibling();
      let backwardCount = Math.floor(maxChildren / 2);
      let backwardNodes = this._readBackward(backwardWalker, backwardCount);
      nodes = backwardNodes;
    }

    // Then read forward by any slack left in the max children...
    let forwardWalker = documentWalker(start);
    let forwardCount = maxChildren - nodes.length;
    nodes = nodes.concat(this._readForward(forwardWalker, forwardCount));

    // If there's any room left, it means we've run all the way to the end.
    // In that case, there might still be more items at the front.
    let remaining = maxChildren - nodes.length;
    if (remaining > 0 && nodes[0]._rawNode != firstChild) {
      let firstNodes = this._readBackward(backwardWalker, remaining);

      // Then put it all back together.
      nodes = firstNodes.concat(nodes);
    }

    return promise.resolve({
      hasFirst: nodes[0]._rawNode == firstChild,
      hasLast: nodes[nodes.length - 1]._rawNode == lastChild,
      children: nodes
    });
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

function documentWalker(node) {
  return new DocumentWalker(node, Ci.nsIDOMNodeFilter.SHOW_ALL, whitespaceTextFilter, false);
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
