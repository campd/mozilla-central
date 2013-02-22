const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/devtools/Loader.jsm");
let require = devtoolsRequire;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/devtools/EventEmitter.jsm");
Cu.import("resource://gre/modules/devtools/dbg-actor-helpers.jsm");
Cu.import("resource:///modules/devtools/CssLogic.jsm");

var { types, params, remotable, Actor, OwnerActor, Front } = Remotable;

let promise = require("sdk/core/promise");
let { Class } = require("sdk/core/heritage");

this.EXPORTED_SYMBOLS = ["DOMWalker", "createWalker"];

this.createWalker = function(target, options) {
  if (target.window) {
    return new DOMWalker(null, target.window.document, options);
  }
  if (target.client) {
    return new DOMWalkerFront(target, options);
  }
};

const ELEMENT_STYLE = 100;

/**
 * Remotable types/params specific to the DOM walker.
 */

var domTypes = {};

// Set up some actor types.  The constructor names correspond to
// managed actor/front tags.
domTypes.Node = types.Actor("node");
domTypes.NodeAttributes = types.Actor("node", "attributes")
domTypes.Nodes = types.Array(domTypes.Node);

domTypes.StyleSheet = types.Actor("sheet");
domTypes.StyleSheets = types.Array(domTypes.StyleSheet);

domTypes.StyleRule = types.Actor("rule");

domTypes.NodeStyleEntry = types.Dict({
  inherited: domTypes.Node,
  rule: domTypes.StyleRule
});

domTypes.NodeStyleEntries = types.Array(domTypes.NodeStyleEntry);

domTypes.NodeStyle = types.Dict({
  sheets: domTypes.StyleSheets,
  document: domTypes.Node,
  computed: domTypes.StyleRule,
  entries: domTypes.NodeStyleEntries
});
domTypes.PseudoModification = types.Context(
  "writePseudoModification",
  "readPseudoModification"
);
domTypes.PseudoModifications = types.Array(domTypes.PseudoModification);

domTypes.RuleCssProperties = types.Actor("rule", "properties");

var domParams = {};
domParams.Node = function(path) {
  return Remotable.Param(path, domTypes.Node);
};
domParams.Nodes = function(path) {
  return Remotable.Param(path, domTypes.Nodes);
};

domParams.StyleSheet = function(path) {
  return Remotable.Param(path, domTypes.StyleSheet);
};

domParams.StyleSheets = function(path) {
  return Remotable.Param(path, domTypes.StyleSheets);
};

domParams.StyleRule = function(path) {
  return Remotable.Param(path, domTypes.StyleRule);
}
domParams.NodeStyle = function(path) {
  return Remotable.Param(path, domTypes.NodeStyle);
};

domParams.PseudoModifications = function(path) {
  return Remotable.Param(path, domTypes.PseudoModifications);
};
domParams.NodeAttributes = function(path) {
  return Remotable.Param(path, domTypes.NodeAttributes);
};
domParams.RuleCssProperties = function(path) {
  return Remotable.Param(path, domTypes.RuleCssProperties);
};

domParams.LongNodeListOptions = params.Options([
  params.Simple("maxNodes"),
  params.Simple("whatToShow"),
  domParams.Node("include")
]);

domParams.LongNodeList = params.Options([
  params.Simple("hasFirst"),
  params.Simple("hasLast"),
  domParams.Nodes("nodes")
]);

domParams.TraversalOptions = params.Options([
  params.Simple("whatToShow")
]);

let DOMRef = Class(Remotable.initActor({
  extends: Actor,

  initialize: function(owner, node) {
    Actor.prototype.initialize.call(this, owner);
    this._rawNode = node;
  },

  actorPrefix: "node",

  toString: function() {
    return "[DOMRef for " + this._rawNode.toString() + "]";
  },

  form: function(hint) {
    let form = {
      actor: this.actorID
    };

    if (this.attributes) {
      form.attrs = this.writeAttrs();
    }

    if (hint === "attributes") {
      return form;
    }

    // XXX: some of these are redundant and should be worked out independently
    // on the client.

    for (let attr of [
      "id", "className", "numChildren",
      "nodeType", "namespaceURI", "tagName", "nodeName", "nodeValue",
      "name", "publicId", "systemId", "pseudoClassLocks"]) {
      form[attr] = this[attr];
    }

    for (let attr of [
      "isDocumentElement", "isNode", "isConnected"]) {
      form[attr] = this[attr]();
    }


    if (this.isWalkerRoot()) {
      form.isWalkerRoot = true;
    }

    return form;
  },

  writeAttrs: function() {
    let attrs = [];
    for (let i = 0; i < this.attributes.length; i++) {
      let attr = this.attributes[i];
      attrs.push({namespace: attr.namespace, name: attr.name, value: attr.value });
    }
    return attrs;
  },

  /**
   * The local dom node represented by this node.  If you
   * use this node, you won't be remote-protocol safe.
   */
  get rawNode() this._rawNode,

  get id() this._rawNode.id,
  get className() this._rawNode.className,

  get hasChildren() !!this._rawNode.firstChild,
  get numChildren() this._rawNode.childNodes.length,
  get nodeType() this._rawNode.nodeType,

  get namespaceURI() this._rawNode.namespaceURI,
  get tagName() this._rawNode.tagName,
  get nodeName() this._rawNode.nodeName,

  get nodeValue() this._rawNode.nodeValue,

  setNodeValue: remotable(function(aValue) {
    this._rawNode.nodeValue = aValue;
    return promise.resolve(undefined);
  }, {
    params: [params.Simple("value")],
    ret: params.Void(),
  }),

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
  hasAttribute: function(attr) this._rawNode.hasAttribute(attr),

  get attributes() this._rawNode.attributes,

  startModifyAttributes: function() {
    return new AttributeModificationList(this);
  },

  /**
   * Takes an array of attribute modifications.  Use startModifyAttributes
   * for a helper API.
   */
  modifyAttributes: remotable(function(attributeMods) {
    for (let mod of attributeMods) {
      if (mod.type == "setAttribute") {
        this.rawNode.setAttribute(mod.name, mod.value);
      } else if (mod.type == "setAttributeNS") {
        this.rawNode.setAttributeNS(mod.namespace, mod.name, mod.value);
      } else if (mod.type == "removeAttribute") {
        this.rawNode.removeAttribute(mod.name);
      } else if (mod.type == "removeAttributeNS") {
        this.rawNode.removeAttributeNS(mod.namespace, mod.name);
      }
    }
    return promise.resolve(this);
  }, {
    params: [ params.SimpleArray("modifications") ],
    ret: domParams.NodeAttributes("attrs")
  }),

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
}));

function AttributeModificationList(node) {
  this.node = node;
  this.modifications = [];
}
AttributeModificationList.prototype = {
  setAttribute: function(name, value) {
    this.modifications.push({ type: "setAttribute", name: name, value: value });
    return this;
  },
  setAttributeNS: function(namespace, name, value) {
    this.modifications.push({ type: "setAttributeNS", namespace: namespace, name: name, value: value });
    return this;
  },
  removeAttribute: function(name, value) {
    this.modifications.push({ type: "removeAttribute", name: name });
    return this;
  },
  removeAttributeNS: function(namespace, name, value) {
    this.modifications.push({ type: "removeAttributeNS", namespace: namespace, name: name });
    return this;
  },
  apply: function(name) {
    return this.node.modifyAttributes(this.modifications);
  }
};

let StyleSheetRef = Class(Remotable.initActor({
  extends: Actor,
  initialize: function(owner, sheet) {
    Actor.prototype.initialize.call(this, owner);
    this.rawSheet = sheet;
  },

  actorPrefix: "sheet",
  toString: function() "[StyleSheetRef for " + this.rawSheet.toString() + "]",

  form: function() {
    let form = {
      actor: this.actorID,
      disabled: this.disabled,
      href: this.href,
      title: this.title,
      type: this.type,
      mediaMatches: this.mediaMatches
    };

    form.media = [];
    for (let i = 0, n = this.media.length; i < n; i++) {
      form.media.push(this.media.item[i]);
    }
    return form;
  },

  get parentStyleSheet() {
    return this.rawSheet.parentStyleSheet ?
      this.owner._sheetRef(this.rawSheet.parentStyleSheet) : null;
  },

  get disabled() this.rawSheet.disabled,
  get href() this.rawSheet.href,
  get media() this.rawSheet.media,
  get title() this.rawSheet.title,
  get type() this.rawSheet.type,

  get _doc() this.rawSheet.ownerNode.ownerDocument,
  get mediaMatches() {
    let mediaText = this.rawSheet.media.mediaText;
    return !mediaText || this._doc.defaultView.
                         matchMedia(mediaText).matches;
  }
}));

let StyleRuleRef = Class(Remotable.initActor({
  extends: Actor,
  initialize: function(owner, item) {
    Actor.prototype.initialize.call(this, owner);
    this.owner = owner;
    this.actorID = owner.pool.add(this);
    if (item instanceof Ci.nsIDOMCSSRule) {
      this.type = item.type;
      this.rawRule = item;

      this.shortSource = CssLogic.shortSource(this.rawRule.parentStyleSheet);
      if (this.rawRule instanceof Ci.nsIDOMCSSStyleRule && this.rawRule.parentStyleSheet) {
        this.ruleLine = DOMUtils.getRuleLine(this.rawRule);
      }
    } else {
      // Element style not attached to a rule.
      this.type = ELEMENT_STYLE;
      this.shortSource = CssLogic.shortSource(null);
      // XXX: this isn't quite right for computed styles...
      this.rawRule = {
        selectorText: "element style",
        style: item,
        toString: function() "[element rule " + this.style + "]"
      };
    }
  },

  actorPrefix: "rule",
  toString: function() "[StyleRuleRef for " + this.rawRule.toString() + "]",

  form: function(hint) {
    if (hint === "properties") {
      return { actor: this.actorID, cssText: this.cssText, properties: this.cssProperties() };
    }

    let form = {
      actor: this.actorID,
      type: this.type,
      shortSource: this.shortSource || undefined,
      ruleLine: this.ruleLine || undefined,
    };

    if (this.parentRule) {
      form.parentRule = this.parentRule.form();
    }

    if (this.parentStyleSheet) {
      form.parentStyleSheet = this.parentStyleSheet.actorID;
    }

    switch (this.type) {
      case Ci.nsIDOMCSSRule.STYLE_RULE:
      case ELEMENT_STYLE:
        form.cssText = this.cssText;
        form.properties = this.cssProperties();
        form.selectorText = this.selectorText;
        break;
      case Ci.nsIDOMCSSRule.CHARSET_RULE:
        form.encoding = this.encoding;
        break;
      case Ci.nsIDOMCSSRule.IMPORT_RULE:
        form.href = this.href;
        // fallthrough
      case Ci.nsIDOMCSSRule.MEDIA_RULE:
        form.media = [];
        for (let i = 0, n = this.media.length; i < n; i++) {
          form.media.push(this.media.item[i]);
        }
        break;
    };

    return form;
  },

  writeCssProperties: function(value) {
    return { cssText: value.cssText, properties: value.cssProperties() };
  },

  get parentRule() {
    if (this.rawRule.parentRule) {
      return this.owner._declRef(this.rawRule.parentRule);
    }
    return null;
  },

  get parentStyleSheet() {
    if (this.rawRule.parentStyleSheet) {
      return this.owner._sheetRef(this.rawRule.parentStyleSheet);
    }
    return null;
  },

  // CSSStyleRule stuff
  get selectorText() this.rawRule.selectorText,

  get cssText() this.rawRule.style.cssText,

  cssTextProperties: function() {
    return (new ParsedCSSText(this.cssText)).props;
  },

  cssProperties: function() {
    let ret = Object.create(null);
    let style = this.rawRule.style;
    for (let i = 0, n = style.length; i < n; i++) {
      let name = style[i];

      ret[name] = {
        value: style.getPropertyValue(name),
        priority: style.getPropertyPriority(name) || undefined,
      };
    }
    return ret;
  },

  getPropertyValue: function(prop) this.rawRule.style.getPropertyValue(prop),
  getPropertyPriority: function(prop) this.rawRule.style.getPropertyPriority(prop),

  removeProperty: remotable(function(propertyName) {
    this.rawRule.style.removeProperty(propertyName);
    return promise.resolve(this.cssText);
  }, {
    params: [params.Simple("property")],
    ret: domParams.RuleCssProperties("properties")
  }),

  setProperty: remotable(function(propertyName, value, priority) {
    this.rawRule.style.setProperty(propertyName, value, priority);
    return promise.resolve(this);
  }, {
    params: [
      params.Simple("property"),
      params.Simple("value"),
      params.Simple("priority")
    ],
    ret: domParams.RuleCssProperties("properties")
  }),

  startModifyStyle: function() {
    return new StyleModificationList(this);
  },

  modifyStyle: remotable(function(modifications) {
    for (mod of modifications) {
      if (mod.type == "setProperty") {
        this.rawRule.style.setProperty(mod.name, mod.value, mod.priority);
      } else if (mod.type == "removeProperty") {
        this.rawRule.style.removeProperty(mod.name);
      }
    }
    return promise.resolve(this);
  }, {
    params: [ params.SimpleArray("modifications") ],
    ret: domParams.RuleCssProperties("properties")
  }),

  // CSSCharsetRule
  get encoding() this.rawRule.encoding,

  // CSSImportRule
  get href() this.rawRule.href,

  // CSSImportRule and CSSMediaRule
  get media() this.rawRule.media,
}));

function StyleModificationList(rule) {
  this.rule = rule;
  this.modifications = [];
}
StyleModificationList.prototype = {
  setProperty: function(name, value, priority) {
    this.modifications.push({ type: "setProperty", name: name, value: value, priority: priority || "" });
    return this;
  },
  removeProperty: function(name) {
    this.modifications.push({ type: "removeProperty", name: name });
    return this;
  },
  apply: function(name) {
    return this.rule.modifyStyle(this.modifications);
  }
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
this.DOMWalker = Class(Remotable.initActor({
  extends: OwnerActor,
  initialize: function(owner, document, options) {
    OwnerActor.prototype.initialize.call(this, owner);
    EventEmitter.decorate(this);

    this._doc = document;
    this._refMap = new WeakMap();
    this._declMap = new Map();
    this._sheetMap = new Map();

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
  },

  actorPrefix: "dom",
  form: function() {
    return { actor: this.actorID };
  },

  toString: function() {
    return "[DOMWalker " + this.actorID + "]";
  },

  disconnect: function() {
    if (this.conn) {
      this.conn.removeActorPool(this.pool);
      this.owner.releaseActor(this);
      delete this.conn;
    }
    delete this.pool;
    delete this.owner;

    if (this._observer) {
      this._observer.disconnect();
      delete this._observer;
    }

    if (this._contentLoadedListener) {
      this._doc.removeEventListener("load", this._contentLoadedListener, true);
      delete this._contentLoadedListener;
    }

    delete this._refMap;
    delete this._declMap;
    delete this._sheetMap;
    delete this._doc;

    this.clearPseudoClassLocks(null, { all: true });
    delete this._pclList;
  },

  destroy: function() {
    this.disconnect();
  },

  _ref: Remotable.manageActors("node", DOMRef, function(node) {
    let ref = new DOMRef(this, node);
    if (this._observer) {
      this._observer.observe(node, {
        attributes: true,
        childList: true,
        characterData: true
      })
    }
    return ref;
  }),

  _sheetRef: Remotable.manageActors("sheet", StyleSheetRef),
  _declRef: Remotable.manageActors("rule", StyleRuleRef),

  // Conversions for protocol types.
  writePseudoModification: function(node) {
    return {
      actor: node.actorID,
      pseudoClassLocks: node.pseudoClassLocks
    }
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

  parents: remotable(function(node, options={}) {
    let walker = documentWalker(node._rawNode);
    let parents = [];
    let cur;
    while(cur = walker.parentNode()) {
      if (options.sameDocument && cur.ownerDocument != node.rawNode.ownerDocument) {
        break;
      }
      parents.push(this._ref(cur));
    }
    return promise.resolve(parents);
  }, {
    params: [
      domParams.Node("node"),
      params.Options([
        params.Simple("sameDocument")
      ])
    ],
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

  insertBefore: remotable(function(node, parent, sibling) {
    parent.rawNode.insertBefore(node.rawNode, sibling ? sibling.rawNode : null);
    return promise.resolve(undefined);
  }, {
    params: [domParams.Node("node"), domParams.Node("parent"), domParams.Node("sibling")],
    ret: params.Void(),
  }),

  nextSibling: remotable(function(node, options={}) {
    let walker = documentWalker(node._rawNode, options.whatToShow || Ci.nsIDOMNodeFilter.SHOW_ALL);
    return promise.resolve(this._ref(walker.nextSibling()));
  }, {
    params: [
      domParams.Node("node"),
      domParams.TraversalOptions
    ],
    ret: domParams.Node("node")
  }),

  previousSibling: remotable(function(node, options={}) {
    let walker = documentWalker(node._rawNode, options.whatToShow || Ci.nsIDOMNodeFilter.SHOW_ALL);
    return promise.resolve(this._ref(walker.previousSibling()));
  }, {
    params: [
      domParams.Node("node"),
      domParams.TraversalOptions
    ],
    ret: domParams.Node("node")
  }),

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

  innerHTML: remotable(function(node) {
    return promise.resolve(new Remotable.LongString(this, node._rawNode.innerHTML));
  }, {
    params: [domParams.Node("node")],
    ret: params.LongStringReturn("innerHTML")
  }),

  outerHTML: remotable(function(node) {
    return promise.resolve(new Remotable.LongString(this, node._rawNode.outerHTML));
  }, {
    params: [domParams.Node("node")],
    ret: params.LongStringReturn("outerHTML")
  }),

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
      params.Options([
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
      params.Options([
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
      params.Options([
        params.Simple("all")
      ])
    ],
    ret: domParams.PseudoModifications("modified")
  }),

  removeNode: remotable(function(node) {
    node.rawNode.parentNode.removeChild(node.rawNode);
    return promise.resolve(undefined);
  }, {
    params: [ domParams.Node("node") ],
    ret: params.Void(),
  }),

  _getStyleSheets: function(doc) {
    let sheets = [];
    let seen = new Set();
    function importSheets(sheet) {
      if (seen.has(sheet)) {
        return;
      }
      seen.add(sheet);
      sheets.push(this._sheetRef(sheet));

      Array.prototype.forEach.call(sheet.cssRules, function(domRule) {
        if (domRule.type == Ci.nsIDOMCSSRule.IMPORT_RULE && domRule.styleSheet) {
          importSheets(aDomRule.styleSheet);
        }
      }, this);
    };
    seen.clear();
    Array.prototype.forEach.call(doc.styleSheets, importSheets, this);
    return sheets;
  },

  getStyleSheets: remotable(function(node) {
    let doc = nodeDoucment(node.rawNode);
    return promise.resolve(this._getStyleSheets(doc));
  }, {
    params: [domParams.Node("node")],
    ret: domParams.StyleSheets("node"),
  }),

  getComputedStyle: remotable(function(node) {
    let win = node.rawNode.ownerDocument.defaultView;
    let computed = win.getComputedStyle(node.rawNode);
    return promise.resolve(new StyleRuleRef(this, computed));
  }, {
    params: [
      domParams.Node("node"),
    ],
    ret: domParams.StyleRule("computed")
  }),

  getNodeStyle: remotable(function(node, options) {
    let rules = [];

    this._addElementRules(rules, node, null, options);

    if (!options.inherited) {
      return promise.resolve(rules);
    }

    let doc = node.rawNode.ownerDocument;

    return this.parents(node, { sameDocument: true }).then(function(parents) {
      for (let parent of parents) {
        this._addElementRules(rules, parent, parent, options);
      }

      let ret = {
        document: this._ref(doc),
        entries: rules
      };

      if (options.sheets) {
        ret.sheets = this._getStyleSheets(doc);
      }

      if (options.computed) {
        let win = node.rawNode.ownerDocument.defaultView;
        ret.computed = new StyleRuleRef(this, win.getComputedStyle(node.rawNode));
      }

      return ret;
    }.bind(this));
  }, {
    params: [
      domParams.Node("node"),
      params.Options([
        params.Simple("inherited"),
        params.Simple("computed"),
        params.Simple("sheets"),
      ])
    ],
    ret: domParams.NodeStyle("style")
  }),

  _addElementRules: function(rules, element, inherited, options)
  {
    rules.push({
      rule: this._declRef(element.rawNode.style),
      inherited: inherited,
    });

    // Get the styles that apply to the element.
    var domRules = DOMUtils.getCSSStyleRules(element.rawNode);

    // getCSStyleRules returns ordered from least-specific to
    // most-specific.
    for (let i = domRules.Count() - 1; i >= 0; i--) {
      let domRule = domRules.GetElementAt(i);

      // XXX: Optionally provide access to system sheets.
      let isSystem = !CssLogic.isContentStylesheet(domRule.parentStyleSheet);

      rules.push({
        rule: this._declRef(domRule),
        inherited: inherited,
        system: isSystem || undefined
      });
    }
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
    if (this.conn) {
      this._sendMutations(refMutations);
    }
  },

  _sendMutations: function(mutations)
  {
    let toSend = [];
    for (let mutation of mutations) {
      let target = mutation.target.actorID;
      if (mutation.type == "childList") {
        toSend.push({
          target: target,
          type: "childList",
          newNumChildren: mutation.target.numChildren,
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
  }
}));

let DOMFront = Class(Remotable.initFront({
  extends: Front,
  actorType: DOMRef,

  initialize: function(owner, form) {
    Front.prototype.initialize.call(this, owner, form);
  },

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

  readNodeAttributes: function(modified) {
    this.form(modified);
    return this;
  },

  _getAttribute: function(name) {
    if (!this._attrMap) {
      this._attrMap = {};
      for (let attr of this.form_attrs) {
        this._attrMap[attr.name] = attr;
      }
    }
    return this._attrMap[name] || undefined;
  },

  getAttribute: function(name) {
    let attr = this._getAttribute(name);
    return attr ? attr.value : null;
  },
  hasAttribute: function(name) {
    return !!this._getAttribute(name);
  },

  get attributes() this.form_attrs,

  startModifyAttributes: function() {
    return new AttributeModificationList(this);
  },

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

  form: function(form) {
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
        this.form_attrs = this.form_attrs.filter(function (a) a.name != mutation.attributeName);
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
    } else if (mutation.type == "childList") {
      this.form_numChildren = mutation.newNumChildren;
    }
  }
}));

let StyleSheetFront = Class(Remotable.initFront({
  extends: Front,
  actorType: StyleSheetRef,
  initialize: function(owner, form) {
    Front.prototype.initialize.call(this, owner, form);
  },

  get disabled() this.form_disabled,
  get href() this.form_href,

  get media() {
    let self = this;
    return {
      length: self.form_media.length,
      item: function(i) self.form_media[i],
      mediaText: self.form_media.join(","),
    }
  },

  get title() this.form_title,
  get type() this.form_type,
  get mediaMatches() this.form_mediaMatches,

  form: function(form) {
    for (let name of Object.getOwnPropertyNames(form)) {
      this["form_" + name] = form[name];
    }
  },
}));


let StyleRuleFront = Class(Remotable.initFront({
  extends: Front,
  actorType: StyleRuleRef,

  initialize: function(owner, form) {
    Front.prototype.initialize.call(this, owner, form);
  },

  get shortSource() this.form_shortSource,
  get ruleLine() this.form_ruleLine,

  get type() this.form_type,
  get parentRule() {
    return this.form_parentRule ? this.owner.readStyleRule(this.form_parentRule) : null;
  },

  get parentStyleSheet() {
    return this.owner._refMap.get(this.form_parentStyleSheet);
  },

  get selectorText() this.form_selectorText,
  get cssText() this.form_cssText,

  _parsedText: function() {
    if (!this.__parsedText) {
      this.__parsedText = new ParsedCSSText(this.cssText);
    }
    return this.__parsedText;
  },

  cssTextProperties: function() {
    return this._parsedText().props;
  },

  cssProperties: function() {
    return this.form_properties;
  },

  getPropertyValue: function(name) {
    let prop = this.form_properties[name] || undefined;
    return prop ? prop.value : prop;
  },

  getPropertyPriority: function(name) {
    let prop = this.form_properties[name] || undefined;
    return prop ? (prop.priority || "") : prop;
  },

  startModifyStyle: function() {
    return new StyleModificationList(this);
  },

  get encoding() this.form_encoding,
  get href() this.form_href,

  get media() {
    let self = this;
    return {
      length: self.form_media.length,
      item: function(i) self.form_media[i],
      mediaText: self.form_media.join(","),
    }
  },

  form: function(form) {
    for (let name of Object.getOwnPropertyNames(form)) {
      this["form_" + name] = form[name];
      if (name == "cssText") {
        delete this.__parsedText;
      }
    }
  },
}));

let DOMWalkerFront = Class(Remotable.initFront({
  extends: Front,
  actorType: DOMWalker,

  initialize: function(target, options) {
    this._client = target.client;

    Front.prototype.initialize.call(this);
    EventEmitter.decorate(this);

    this._refMap = new Map();
    this._boundOnMutations = this._onMutations.bind(this);
    this.client.addListener("mutations", this._boundOnMutations);

    this.options = options;

    // Start fetching an actor to back the options.
    this.actorPromise = this.rawRequest({
      to: target.form.inspectorActor,
      type: "getWalker"
    }).then(function(response) {
      this.actorID = response.actor;
      return this.actorID;
    }.bind(this)).then(promisePass, promiseError);
  },

  actor: function() {
    return this.actorPromise;
  },
  get client() this._client,

  destroy: function() {
    // XXX: disconnect the actor.
    this.client.removeListener("mutations", this._boundOnMutations);
    delete this._boundOnMutations;
  },

  getNode: Remotable.manageFronts("node", DOMFront),
  getSheet: Remotable.manageFronts("sheet", StyleSheetFront),
  getRule: Remotable.manageFronts("rule", StyleRuleFront),

  readPseudoModification: function(modified) {
    let ref = this._refMap.get(modified.actor);
    if (ref) {
      ref._updateLocks(modified);
    }
    return ref;
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
}));

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
  if (!node){
    try { throw new Error(); } catch(e) { dump(e.stack + "\n") }
  }
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

// Used to split on css line separators
const CSS_LINE_RE = /(?:[^;\(]*(?:\([^\)]*?\))?[^;\(]*)*;?/g;

// Used to parse a single property line.
const CSS_PROP_RE = /\s*([^:\s]*)\s*:\s*(.*?)\s*(?:! (important))?;?$/;

function ParsedCSSText(cssText)
{
  let parsed = [];
  let lines = cssText.match(CSS_LINE_RE);
  for (let line of lines) {
    let matches = CSS_PROP_RE.exec(line);
    if (!matches || !matches[2])
      continue;

    let name = matches[1];
    let value = matches[2];
    let priority = matches[3] || "";
    parsed.push({ name: matches[1], value: matches[2], priority: matches[3] || ""});
  }
  this.props = parsed;
}

ParsedCSSText.prototype = {
  getProperty: function(prop) {
    if (!this._propMap) {
      this._propMap = Object.create(null);
      for (let prop of this.props) {
        this._propMap[prop.name] = prop;
      }
    }
    return this._propMap[prop.name];
  },
  getPropertyValue: function(prop) {
    return this.getProperty(prop).name;
  },
  getPropertyPriority: function(prop) {
    return this.getProperty(prop).priority;
  }
};

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
