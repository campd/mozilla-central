/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cc = Components.classes;
const Cu = Components.utils;
const Ci = Components.interfaces;

// Page size for pageup/pagedown
const PAGE_SIZE = 10;

const PREVIEW_AREA = 700;
const DEFAULT_MAX_NODES = 100;

this.EXPORTED_SYMBOLS = ["MarkupView"];

Cu.import("resource://gre/modules/devtools/Loader.jsm");
let require = devtoolsRequire;

Cu.import("resource:///modules/devtools/LayoutHelpers.jsm");
Cu.import("resource:///modules/devtools/CssRuleView.jsm");
Cu.import("resource:///modules/devtools/Templater.jsm");
Cu.import("resource:///modules/devtools/Undo.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let promise = require("sdk/core/promise");

/**
 * Vocabulary for the purposes of this file:
 *
 * MarkupContainer - the structure that holds an editor and its
 *  immediate children in the markup panel.
 * Node - A content node.
 * object.elt - A UI element in the markup panel.
 */

/**
 * The markup tree.  Manages the mapping of nodes to MarkupContainers,
 * updating based on mutations, and the undo/redo bindings.
 *
 * @param Inspector aInspector
 *        The inspector we're watching.
 * @param iframe aFrame
 *        An iframe in which the caller has kindly loaded markup-view.xhtml.
 */
this.MarkupView = function MarkupView(aInspector, aFrame, aControllerWindow)
{
  this._inspector = aInspector;
  this._target = aInspector._target;
  this._frame = aFrame;
  this.doc = this._frame.contentDocument;
  this._elt = this.doc.querySelector("#root");

  try {
    this.maxNodes = Services.prefs.getIntPref("devtools.markup.pagesize");
  } catch(ex) {
    this.maxNodes = DEFAULT_MAX_NODES;
  }

  this.undo = new UndoStack();
  // XXX: we're getting a null controller window from a remote target.
  if (aControllerWindow) {
    this.undo.installController(aControllerWindow);
  }

  this._containers = new WeakMap();

  this._boundOnNewSelection = this._onNewSelection.bind(this);
  this._inspector.selection.on("new-node", this._boundOnNewSelection);
  this._onNewSelection();

  this._boundKeyDown = this._onKeyDown.bind(this);
  this._frame.contentWindow.addEventListener("keydown", this._boundKeyDown, false);

  this._boundFocus = this._onFocus.bind(this);
  this._frame.addEventListener("focus", this._boundFocus, false);

  this.walker = aInspector.walker;
  this._boundMutationObserver = this._mutationObserver.bind(this);
  this.walker.on("mutations", this._boundMutationObserver);

  this.walker.document().then(function(node) {
    let container = this.importNode(node);
    this._updateChildren(container);
  }.bind(this)).then(promisePass, promiseError);

  this._initPreview();
}

MarkupView.prototype = {
  _selectedContainer: null,

  template: function MT_template(aName, aDest, aOptions={stack: "markup-view.xhtml"})
  {
    let node = this.doc.getElementById("template-" + aName).cloneNode(true);
    node.removeAttribute("id");
    template(node, aDest, aOptions);
    return node;
  },

  /**
   * Get the MarkupContainer object for a given node, or undefined if
   * none exists.
   */
  getContainer: function MT_getContainer(aNode)
  {
    return this._containers.get(aNode);
  },

  /**
   * Highlight the inspector selected node.
   */
  _onNewSelection: function MT__onNewSelection()
  {
    if (this._inspector.selection.isNode()) {
      let node = this._inspector.selection.nodeRef;
      if (this._selectedContainer && node === this._selectedContainer.node) {
        return;
      }

      // Try to mark the node selected immediately.  If it doesn't work
      // we'll try again.
      if (this._containers.get(node)) {
        this.markNodeAsSelected(node);
      }

      this.importNodeDeep(node).then(function() {
        return this.showNode(node, true);
      }.bind(this)).then(function() {
        this.markNodeAsSelected(node);
      }.bind(this)).then(promisePass, promiseError);
    } else {
      this.unmarkSelectedNode();
    }
  },

  /**
   * Create a TreeWalker to find the next/previous
   * node for selection.
   */
  _selectionWalker: function MT__selectionWalker(aCurrent)
  {
    let walker = this.doc.createTreeWalker(
      this._elt,
      Ci.nsIDOMNodeFilter.SHOW_ELEMENT,
      function(aElement) {
        if (aElement.container && aElement.container.visible) {
          return Ci.nsIDOMNodeFilter.FILTER_ACCEPT;
        }
        return Ci.nsIDOMNodeFilter.FILTER_SKIP;
      }
    );
    walker.currentNode = aCurrent || this._selectedContainer.elt;
    return walker;
  },

  /**
   * Key handling.
   */
  _onKeyDown: function MT__KeyDown(aEvent)
  {
    let handled = true;

    // Ignore keystrokes that originated in editors.
    if (aEvent.target.tagName.toLowerCase() === "input" ||
        aEvent.target.tagName.toLowerCase() === "textarea") {
      return;
    }

    switch(aEvent.keyCode) {
      case Ci.nsIDOMKeyEvent.DOM_VK_DELETE:
      case Ci.nsIDOMKeyEvent.DOM_VK_BACK_SPACE:
        this.deleteNode(this._selectedContainer.node);
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_HOME: {
        let rootContainer = this._containers.get(this._rootNode);
        this.navigate(rootContainer.children.firstChild.container);
        break;
      }
      case Ci.nsIDOMKeyEvent.DOM_VK_LEFT:
        this.collapseNode(this._selectedContainer.node);
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_RIGHT:
        this.expandNode(this._selectedContainer.node);
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_UP:
        let prev = this._selectionWalker().previousNode();
        if (prev) {
          this.navigate(prev.container);
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_DOWN:
        let next = this._selectionWalker().nextNode();
        if (next) {
          this.navigate(next.container);
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_PAGE_UP: {
        let walker = this._selectionWalker();
        let selection = this._selectedContainer;
        for (let i = 0; i < PAGE_SIZE; i++) {
          let prev = walker.previousNode();
          if (!prev) {
            break;
          }
          selection = prev.container;
        }
        this.navigate(selection);
        break;
      }
      case Ci.nsIDOMKeyEvent.DOM_VK_PAGE_DOWN: {
        let walker = this._selectionWalker();
        let selection = this._selectedContainer;
        for (let i = 0; i < PAGE_SIZE; i++) {
          let next = walker.nextNode();
          if (!next) {
            break;
          }
          selection = next.container;
        }
        this.navigate(selection);
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      aEvent.stopPropagation();
      aEvent.preventDefault();
    }
  },

  /**
   * Delete a node from the DOM.
   * This is an undoable action.
   */
  deleteNode: function MC__deleteNode(aNode)
  {
    let self = this;
    return this._document(aNode).then(function(aDocument) {
      if (aNode === aDocument ||
          aNode.isDocumentElement() ||
          aNode.nodeType === Ci.nsIDOMNode.DOCUMENT_TYPE_NODE) {
        return;
      }

      self._parent(aNode).then(function(aParent) {
        return self.walker.nextSibling(aNode).then(function(aNextSibling) {
          self.undo.do(function() {
            self.walker.removeNode(aNode);
          }, function() {
            self.walker.insertBefore(aNode, aParent, aNextSibling);
          });
        });
      });
    });

  },

  /**
   * If an editable item is focused, select its container.
   */
  _onFocus: function MC__onFocus(aEvent) {
    let parent = aEvent.target;
    while (!parent.container) {
      parent = parent.parentNode;
    }
    if (parent) {
      this.navigate(parent.container, true);
    }
  },

  /**
   * Handle a user-requested navigation to a given MarkupContainer,
   * updating the inspector's currently-selected node.
   *
   * @param MarkupContainer aContainer
   *        The container we're navigating to.
   * @param aIgnoreFocus aIgnoreFocus
   *        If falsy, keyboard focus will be moved to the container too.
   */
  navigate: function MT__navigate(aContainer, aIgnoreFocus)
  {
    if (!aContainer) {
      return;
    }

    if (this._selectedContainer === aContainer) {
      // Nothing to do here.
      return;
    }

    let node = aContainer.node;

    this.scrollToNode(node, false);

    this._inspector.selection.setNodeRef(node, "treepanel");
    // This event won't be fired if the node is the same. But the highlighter
    // need to lock the node if it wasn't.
    this._inspector.selection.emit("new-node");

    if (!aIgnoreFocus) {
      aContainer.focus();
    }
  },

  importNodeDeep: function MT_importNodeDeep(aNode)
  {
    // If this node is already included, we don't need to fetch parents.
    if (this._containers.has(aNode)) {
      return promise.resolve(undefined);
    }

    return this.walker.parents(aNode).then(function(aParents) {
      aParents.reverse();
      for (let parent of aParents) {
        this.importNode(parent);
      }
      this.importNode(aNode);
      return promise.resolve(undefined);
    }.bind(this)).then(promisePass, promiseError);
  },

  /**
   * Make sure a node is included in the markup tool.
   *
   * @param DOMNode aNode
   *        The node in the content document.
   *
   * @returns MarkupContainer The MarkupContainer object for this element.
   */
  importNode: function MT_importNode(aNode)
  {
    // New assumption: parents are assumed to already be imported
    if (!aNode) {
      return null;
    }

    if (this._containers.has(aNode)) {
      return this._containers.get(aNode);
    }

    if (!aNode.isWalkerRoot()) {
      var container = new MarkupContainer(this, aNode);
    } else {
      var container = new RootContainer(this, aNode);
      this._elt.appendChild(container.elt);
      this._rootNode = aNode;
    }

    this._containers.set(aNode, container);

    container.hasChildren = aNode.hasChildren;
    container.childrenDirty = true;

    return container;
  },

  /**
   * Mutation observer used for included nodes.
   */
  _mutationObserver: function MT__mutationObserver(aEvent, aMutations)
  {
    let promises = [];
    for (let mutation of aMutations) {
      let container = this._containers.get(mutation.target);
      if (!container) {
        // Container might not exist if this came from a load event for an iframe
        // we're not viewing.
        continue;
      }
      if (mutation.type === "attributes" || mutation.type === "characterData") {
        container.update();
      } else if (mutation.type === "childList") {
        container.childrenDirty = true;
        // XXX: what if the visible child isn't still here?
        promises.push(this._updateChildren(container));
      }
    }
    promised(Array).apply(null, promises).then(function() {
      this._inspector.emit("markupmutation");
    }.bind(this)).then(promisePass, promiseError);
  },

  /**
   * XXX: the dom walker client should really be doing the caching
   * here.
   * @returns an array of nodes, or null if we don't trust the
   *          hierarchy.
   */
  _localParents: function MT__localParents(aNode)
  {
    if (aNode === this._rootNode) {
      // Trustworthy, but empty.
      return [];
    }

    let container = this._containers.get(aNode);
    if (!container) {
      // We don't have the node at all.
      return null;
    }

    let rootContainer = this._containers.get(this._rootNode);
    let parents = [];
    container = container.parentContainer;
    while (container) {
      if (container.childrenDirty) {
        // We can't trust the local list.
        return null;
      }
      parents.push(container.node);
      if (container === rootContainer) {
        return parents;
      }

      container = container.parentContainer;
    }

    // We didn't reach the root, we don't have a good list.
    return null;
  },

  /**
   * Returns parents of the node, using the local structure
   * if we think it's trustworthy.
   */
  _parents: function MT__parents(aNode)
  {
    let parents = this._localParents(aNode);
    if (parents !== null) {
      return promise.resolve(parents);
    }
    return this.walker.parents(aNode);
  },

  /**
   * Return the immediate parent of the node, using the local structure
   * if we think it's trustworthy.
   */
  _parent: function MT_parent(aNode)
  {
    return this._parents(aNode).then(function(aParents) {
      return aParents.length > 0 ? aParents[0] : null;
    });
  },

  /**
   * Returns the document for a node, using the local structure
   * if we think it's trustworthy.
   */
  _document: function MT__document(aNode) {
    if (aNode.nodeType == Ci.nsIDOMNode.DOCUMENT_NODE) {
      return promise.resolve(aNode);
    }
    let parents  = this._localParents(aNode);
    if (parents) {
      for (let i = 0, n = parents.length; i < n; i++) {
        if (parents[i].nodeType == Ci.nsIDOMNode.DOCUMENT_NODE) {
          return promise.resolve(parents[i]);
        }
      }
    }
    // Didn't find a local document parent, ask the server.
    return this.walker.document(aNode);
  },

  /**
   * Make sure the given node's parents are expanded and the
   * node is scrolled on to screen.
   *
   * Assumes the node is already imported.
   */
  showNode: function MT_showNode(aNode, centered)
  {
    return this._parents(aNode).then(function(aParents) {
      let promises = [];
      for (let i = 0; i < aParents.length; i++) {
        let parent = aParents[i];
        let visibleChild = i == 0 ? aNode : aParents[i - 1];
        promises.push(this.expandNode(parent, visibleChild));
      }
      return promised(Array).apply(undefined, promises);
    }.bind(this)).then(function() {
      this.scrollToNode(aNode, centered);
    }.bind(this)).then(promisePass, promiseError);
  },

  scrollToNode: function MT_scrollToNode(aNode, aCentered)
  {
    let container = this._containers.get(aNode);
    LayoutHelpers.scrollIntoViewIfNeeded(container.editor.elt, aCentered);
  },

  /**
   * Expand the container's children.
   */
  _expandContainer: function MT__expandContainer(aContainer, aVisibleChild)
  {
    if (aContainer.hasChildren) {
      aContainer.expanded = true;
      return this._updateChildren(aContainer, aVisibleChild);
    }
    return promise.resolve(undefined);
  },

  /**
   * Expand the node's children.
   */
  expandNode: function MT_expandNode(aNode, aVisibleChild)
  {
    let container = this._containers.get(aNode);
    return this._expandContainer(container, aVisibleChild);
  },

  /**
   * Expand the entire tree beneath a container.
   *
   * @param aContainer The container to expand.
   * XXX: should return a promise for when this is done.
   * XXX: in fact, I'm not sure this works for async stuff at all.
   */
  _expandAll: function MT_expandAll(aContainer)
  {
    this._expandContainer(aContainer);
    let child = aContainer.children.firstChild;
    while (child) {
      this._expandAll(child.container);
      child = child.nextSibling;
    }
  },

  /**
   * Expand the entire tree beneath a node.
   *
   * @param aContainer The node to expand, or null
   *        to start from the top.
   */
  expandAll: function MT_expandAll(aNode)
  {
    aNode = aNode || this._rootNode;
    this._expandAll(this._containers.get(aNode));
  },

  /**
   * Collapse the node's children.
   */
  collapseNode: function MT_collapseNode(aNode)
  {
    let container = this._containers.get(aNode);
    container.expanded = false;
    return promise.resolve(undefined)
  },

  /**
   * Mark the given node selected.
   */
  markNodeAsSelected: function MT_markNodeAsSelected(aNode)
  {
    let container = this._containers.get(aNode);
    if (this._selectedContainer === container) {
      return false;
    }
    if (this._selectedContainer) {
      this._selectedContainer.selected = false;
    }
    this._selectedContainer = container;
    if (aNode) {
      this._selectedContainer.selected = true;
    }

    return true;
  },

  /**
   * Unmark selected node (no node selected).
   */
  unmarkSelectedNode: function MT_unmarkSelectedNode()
  {
    if (this._selectedContainer) {
      this._selectedContainer.selected = false;
      this._selectedContainer = null;
    }
  },

  /**
   * Called when the markup panel initiates a change on a node.
   */
  nodeChanged: function MT_nodeChanged(aNode)
  {
//    if (aNode === this._inspector.selection.nodeRef) {
//      this._inspector.change("markupview");
//    }
  },

  /**
   * Make sure all children of the given container's node are
   * imported and attached to the container in the right order.
   * @param aCentered If provided, this child will be included
   *        in the visible subset, and will be roughly centered
   *        in that list.
   */
  _updateChildren: function MT__updateChildren(aContainer, aVisibleChild)
  {
    if (aVisibleChild) {
      // If the requested visible child isn't attached, assume children
      // are dirty.
      let childContainer = this._containers.get(aVisibleChild);
      if (childContainer &&
          childContainer.elt.parentNode != aContainer.children) {
        aContainer.childrenDirty = true;
      }
    }

    if (!aContainer.childrenDirty) {
      return promise.resolve(undefined);
    }

    // Get a tree walker pointing at the first child of the node.
    aContainer.hasChildren = aContainer.node.hasChildren;

    if (!aContainer.expanded) {
      return promise.resolve(undefined);
    }

    return this.walker.children(aContainer.node, {
      include: aVisibleChild,
      maxNodes: aContainer.maxNodes || this.maxNodes
    }).then(function(children) {
      aContainer.childrenDirty = false;
      let fragment = this.doc.createDocumentFragment();

      for (let child of children.nodes) {
        let container = this.importNode(child, false);
        fragment.appendChild(container.elt);
      }

      while (aContainer.children.firstChild) {
        aContainer.children.removeChild(aContainer.children.firstChild);
      }

      if (!(children.hasFirst && children.hasLast)) {
        let data = {
          showing: this.strings.GetStringFromName("markupView.more.showing"),
          showAll: this.strings.formatStringFromName(
                    "markupView.more.showAll",
                    [aContainer.node.numChildren.toString()], 1),
          allButtonClick: function() {
            aContainer.maxNodes = -1;
            aContainer.childrenDirty = true;
            this._updateChildren(aContainer);
          }.bind(this)
        };

        if (!children.hasFirst) {
          let span = this.template("more-nodes", data);
          fragment.insertBefore(span, fragment.firstChild);
        }
        if (!children.hasLast) {
          let span = this.template("more-nodes", data);
          fragment.appendChild(span);
        }
      }

      aContainer.children.appendChild(fragment);
    }.bind(this)).then(promisePass, promiseError);
  },

  /**
   * Tear down the markup panel.
   */
  destroy: function MT_destroy()
  {
    this.walker.off("mutations", this._boundMutationObserver);
    delete this._boundMutationObserver;

    this.undo.destroy();
    delete this.undo;

    this._frame.removeEventListener("focus", this._boundFocus, false);
    delete this._boundFocus;

    if (this._boundUpdatePreview) {
      this._frame.contentWindow.removeEventListener("scroll", this._boundUpdatePreview, true);
      this._frame.contentWindow.removeEventListener("resize", this._boundUpdatePreview, true);
      this._frame.contentWindow.removeEventListener("overflow", this._boundResizePreview, true);
      this._frame.contentWindow.removeEventListener("underflow", this._boundResizePreview, true);
      delete this._boundUpdatePreview;
    }

    this._frame.contentWindow.removeEventListener("keydown", this._boundKeyDown, true);
    delete this._boundKeyDown;

    this._inspector.selection.off("new-node", this._boundOnNewSelection);
    delete this._boundOnNewSelection;

    delete this._elt;

    delete this._containers;
  },

  /**
   * Initialize the preview panel.
   */
  _initPreview: function MT_initPreview()
  {
    if (!Services.prefs.getBoolPref("devtools.inspector.markupPreview")) {
      return;
    }

    this._previewBar = this.doc.querySelector("#previewbar");
    this._preview = this.doc.querySelector("#preview");
    this._viewbox = this.doc.querySelector("#viewbox");

    this._previewBar.classList.remove("disabled");

    this._previewWidth = this._preview.getBoundingClientRect().width;

    this._boundResizePreview = this._resizePreview.bind(this);
    this._frame.contentWindow.addEventListener("resize", this._boundResizePreview, true);
    this._frame.contentWindow.addEventListener("overflow", this._boundResizePreview, true);
    this._frame.contentWindow.addEventListener("underflow", this._boundResizePreview, true);

    this._boundUpdatePreview = this._updatePreview.bind(this);
    this._frame.contentWindow.addEventListener("scroll", this._boundUpdatePreview, true);
    this._updatePreview();
  },


  /**
   * Move the preview viewbox.
   */
  _updatePreview: function MT_updatePreview()
  {
    let win = this._frame.contentWindow;

    if (win.scrollMaxY == 0) {
      this._previewBar.classList.add("disabled");
      return;
    }

    this._previewBar.classList.remove("disabled");

    let ratio = this._previewWidth / PREVIEW_AREA;
    let width = ratio * win.innerWidth;

    let height = ratio * (win.scrollMaxY + win.innerHeight);
    let scrollTo
    if (height >= win.innerHeight) {
      scrollTo = -(height - win.innerHeight) * (win.scrollY / win.scrollMaxY);
      this._previewBar.setAttribute("style", "height:" + height + "px;transform:translateY(" + scrollTo + "px)");
    } else {
      this._previewBar.setAttribute("style", "height:100%");
    }

    let bgSize = ~~width + "px " + ~~height + "px";
    this._preview.setAttribute("style", "background-size:" + bgSize);

    let height = ~~(win.innerHeight * ratio) + "px";
    let top = ~~(win.scrollY * ratio) + "px";
    this._viewbox.setAttribute("style", "height:" + height + ";transform: translateY(" + top + ")");
  },

  /**
   * Hide the preview while resizing, to avoid slowness.
   */
  _resizePreview: function MT_resizePreview()
  {
    let win = this._frame.contentWindow;
    this._previewBar.classList.add("hide");
    win.clearTimeout(this._resizePreviewTimeout);

    win.setTimeout(function() {
      this._updatePreview();
      this._previewBar.classList.remove("hide");
    }.bind(this), 1000);
  },

};


/**
 * The main structure for storing a document node in the markup
 * tree.  Manages creation of the editor for the node and
 * a <ul> for placing child elements, and expansion/collapsing
 * of the element.
 *
 * @param MarkupView aMarkupView
 *        The markup view that owns this container.
 * @param DOMNode aNode
 *        The node to display.
 */
function MarkupContainer(aMarkupView, aNode)
{
  this.markup = aMarkupView;
  this.doc = this.markup.doc;
  this.undo = this.markup.undo;
  this.node = aNode;

  if (aNode.nodeType == Ci.nsIDOMNode.TEXT_NODE) {
    this.editor = new TextEditor(this, aNode, "text");
  } else if (aNode.nodeType == Ci.nsIDOMNode.COMMENT_NODE) {
    this.editor = new TextEditor(this, aNode, "comment");
  } else if (aNode.nodeType == Ci.nsIDOMNode.ELEMENT_NODE) {
    this.editor = new ElementEditor(this, aNode);
  } else if (aNode.nodeType == Ci.nsIDOMNode.DOCUMENT_TYPE_NODE) {
    this.editor = new DoctypeEditor(this, aNode);
  } else {
    this.editor = new GenericEditor(this.markup, aNode);
  }

  // The template will fill the following properties
  this.elt = null;
  this.expander = null;
  this.codeBox = null;
  this.children = null;
  this.markup.template("container", this);
  this.elt.container = this;
  this.children.childrenContainer = this;

  this.expander.addEventListener("click", function() {
    this.markup.navigate(this);

    if (this.expanded) {
      this.markup.collapseNode(this.node);
    } else {
      this.markup.expandNode(this.node);
    }
  }.bind(this));

  this.codeBox.insertBefore(this.editor.elt, this.children);

  this.editor.elt.addEventListener("mousedown", function(evt) {
    this.markup.navigate(this);
  }.bind(this), false);

  if (this.editor.summaryElt) {
    this.editor.summaryElt.addEventListener("click", function(evt) {
      this.markup.navigate(this);
      this.markup.expandNode(this.node);
    }.bind(this), false);
    this.codeBox.appendChild(this.editor.summaryElt);
  }

  if (this.editor.closeElt) {
    this.editor.closeElt.addEventListener("mousedown", function(evt) {
      this.markup.navigate(this);
    }.bind(this), false);
    this.codeBox.appendChild(this.editor.closeElt);
  }

}

MarkupContainer.prototype = {
  /**
   * True if the current node has children.  The MarkupView
   * will set this attribute for the MarkupContainer.
   */
  _hasChildren: false,

  get hasChildren() {
    return this._hasChildren;
  },

  set hasChildren(aValue) {
    this._hasChildren = aValue;
    if (aValue) {
      this.expander.style.visibility = "visible";
    } else {
      this.expander.style.visibility = "hidden";
    }
  },

  /**
   * True if the node has been visually expanded in the tree.
   */
  get expanded() {
    return this.children.hasAttribute("expanded");
  },

  set expanded(aValue) {
    if (aValue) {
      this.expander.setAttribute("expanded", "");
      this.children.setAttribute("expanded", "");
      if (this.editor.summaryElt) {
        this.editor.summaryElt.setAttribute("expanded", "");
      }
    } else {
      this.expander.removeAttribute("expanded");
      this.children.removeAttribute("expanded");
      if (this.editor.summaryElt) {
        this.editor.summaryElt.removeAttribute("expanded");
      }
    }
  },

  /**
   * True if the container is visible in the markup tree.
   */
  get visible()
  {
    return this.elt.getBoundingClientRect().height > 0;
  },

  /**
   * True if the container is currently selected.
   */
  _selected: false,

  get selected() {
    return this._selected;
  },

  set selected(aValue) {
    this._selected = aValue;
    if (this._selected) {
      this.editor.elt.classList.add("selected");
      if (this.editor.closeElt) {
        this.editor.closeElt.classList.add("selected");
      }
    } else {
      this.editor.elt.classList.remove("selected");
      if (this.editor.closeElt) {
        this.editor.closeElt.classList.remove("selected");
      }
    }
  },

  /**
   * Update the container's editor to the current state of the
   * viewed node.
   */
  update: function MC_update()
  {
    if (this.editor.update) {
      this.editor.update();
    }
  },

  /**
   * Try to put keyboard focus on the current editor.
   */
  focus: function MC_focus()
  {
    let focusable = this.editor.elt.querySelector("[tabindex]");
    if (focusable) {
      focusable.focus();
    }
  },

  /**
   * Return the container above this container in the document.
   * This might not always match the element's parent's container
   * (for example, if the parent container's chidlren list is out of date)
   */
  get parentContainer() {
    return this.elt.parentNode ? this.elt.parentNode.childrenContainer : null;
  }
}

/**
 * Dummy container node used for the root document element.
 */
function RootContainer(aMarkupView, aNode)
{
  this.doc = aMarkupView.doc;
  this.elt = this.doc.createElement("ul");
  this.elt.container = this;
  this.children = this.elt;
  this.node = aNode;
  this.parentContainer = null;
}

/**
 * Creates an editor for simple nodes.
 */
function GenericEditor(aContainer, aNode)
{
  this.elt = aContainer.doc.createElement("span");
  this.elt.className = "editor";
  this.elt.textContent = aNode.nodeName;
}

/**
 * Creates an editor for a DOCTYPE node.
 *
 * @param MarkupContainer aContainer The container owning this editor.
 * @param DOMNode aNode The node being edited.
 */
function DoctypeEditor(aContainer, aNode)
{
  this.elt = aContainer.doc.createElement("span");
  this.elt.className = "editor comment";
  this.elt.textContent = '<!DOCTYPE ' + aNode.name +
     (aNode.publicId ? ' PUBLIC "' +  aNode.publicId + '"': '') +
     (aNode.systemId ? ' "' + aNode.systemId + '"' : '') +
     '>';
}

/**
 * Creates a simple text editor node, used for TEXT and COMMENT
 * nodes.
 *
 * @param MarkupContainer aContainer The container owning this editor.
 * @param DOMNode aNode The node being edited.
 * @param string aTemplate The template id to use to build the editor.
 */
function TextEditor(aContainer, aNode, aTemplate)
{
  this.node = aNode;

  aContainer.markup.template(aTemplate, this);

  this.update();

  _editableField({
    element: this.value,
    stopOnReturn: true,
    trigger: "dblclick",
    multiline: true,
    done: function TE_done(aVal, aCommit) {
      if (!aCommit) {
        return;
      }
      let oldValue = this.node.nodeValue;
      aContainer.undo.do(function() {
        this.node.setNodeValue(aVal).then(function() {
          aContainer.markup.nodeChanged(this.node);
        }.bind(this));
      }.bind(this), function() {
        this.node.setNodeValue(oldValue).then(function() {
          aContainer.markup.nodeChanged(this.node);
        }.bind(this));
      }.bind(this));
    }.bind(this)
  });
}

TextEditor.prototype = {
  update: function TE_update()
  {
    this.value.textContent = this.node.nodeValue;
  }
};

/**
 * Creates an editor for an Element node.
 *
 * @param MarkupContainer aContainer The container owning this editor.
 * @param Element aNode The node being edited.
 */
function ElementEditor(aContainer, aNode)
{
  this.doc = aContainer.doc;
  this.undo = aContainer.undo;
  this.template = aContainer.markup.template.bind(aContainer.markup);
  this.container = aContainer;
  this.markup = this.container.markup;
  this.node = aNode;
  this.rawNode = aNode.rawNode;

  this.attrs = [];

  // The templates will fill the following properties
  this.elt = null;
  this.tag = null;
  this.attrList = null;
  this.newAttr = null;
  this.summaryElt = null;
  this.closeElt = null;

  // Create the main editor
  this.template("element", this);

  if (this.node.numChildren > 0 ||
      (this.node.nodeValue && this.node.nodeValue.length > 0)) {
    // Create the summary placeholder
    this.template("elementContentSummary", this);
  }

  // Create the closing tag
  this.template("elementClose", this);

  let tagName = this.node.nodeName.toLowerCase();
  this.tag.textContent = tagName;
  this.closeTag.textContent = tagName;

  this.update();

  // Make the tag name editable (unless this is a document element)
  // XXX: or unless we're remote, for now.
  if (!aNode.isDocumentElement() || !this.rawNode) {
    this.tag.setAttribute("tabindex", "0");
    _editableField({
      element: this.tag,
      trigger: "dblclick",
      stopOnReturn: true,
      done: this.onTagEdit.bind(this),
    });
  }

  // Make the new attribute space editable.
  _editableField({
    element: this.newAttr,
    trigger: "dblclick",
    stopOnReturn: true,
    done: function EE_onNew(aVal, aCommit) {
      if (!aCommit) {
        return;
      }

      try {
        let doMods = this.node.startModifyAttributes();
        let undoMods = this.node.startModifyAttributes();
        this._applyAttributes(aVal, null, doMods, undoMods);
        this.undo.do(function() {
          doMods.apply();
        }, function() {
          undoMods.apply();
        });
      } catch (x) {
        Cu.reportError(x);
        return;
      }
    }.bind(this)
  });

}

ElementEditor.prototype = {
  /**
   * Update the state of the editor from the node.
   */
  update: function EE_update()
  {
    let attrs = this.node.attributes;
    if (!attrs) {
      return;
    }

    // Hide all the attribute editors, they'll be re-shown if they're
    // still applicable.  Don't update attributes that are being
    // actively edited.
    let attrEditors = this.attrList.querySelectorAll(".attreditor");
    for (let i = 0; i < attrEditors.length; i++) {
      if (!attrEditors[i].inplaceEditor) {
        attrEditors[i].style.display = "none";
      }
    }

    // Get the attribute editor for each attribute that exists on
    // the node and show it.
    for (let i = 0; i < attrs.length; i++) {
      let attr = this._createAttribute(attrs[i]);
      if (!attr.inplaceEditor) {
        attr.style.removeProperty("display");
      }
    }
  },

  _createAttribute: function EE_createAttribute(aAttr, aBefore)
  {
    if (aAttr.name in this.attrs) {
      var attr = this.attrs[aAttr.name];
      var name = attr.querySelector(".attrname");
      var val = attr.querySelector(".attrvalue");
    } else {
      // Create the template editor, which will save some variables here.
      let data = {
        attrName: aAttr.name,
      };
      this.template("attribute", data);
      var {attr, inner, name, val} = data;

      // Figure out where we should place the attribute.
      let before = aBefore || null;
      if (aAttr.name == "id") {
        before = this.attrList.firstChild;
      } else if (aAttr.name == "class") {
        let idNode = this.attrs["id"];
        before = idNode ? idNode.nextSibling : this.attrList.firstChild;
      }
      this.attrList.insertBefore(attr, before);

      // Make the attribute editable.
      _editableField({
        element: inner,
        trigger: "dblclick",
        stopOnReturn: true,
        selectAll: false,
        start: function EE_editAttribute_start(aEditor, aEvent) {
          // If the editing was started inside the name or value areas,
          // select accordingly.
          if (aEvent && aEvent.target === name) {
            aEditor.input.setSelectionRange(0, name.textContent.length);
          } else if (aEvent && aEvent.target === val) {
            let length = val.textContent.length;
            let editorLength = aEditor.input.value.length;
            let start = editorLength - (length + 1);
            aEditor.input.setSelectionRange(start, start + length);
          } else {
            aEditor.input.select();
          }
        },
        done: function EE_editAttribute_done(aVal, aCommit) {
          if (!aCommit) {
            return;
          }

          let doMods = this.node.startModifyAttributes();
          let undoMods = this.node.startModifyAttributes();

          // Remove the attribute stored in this editor and re-add any attributes
          // parsed out of the input element. Bail out if parsing fails.
          try {
            var self = this;
            this._saveAttribute(aAttr.name, undoMods);
            doMods.removeAttribute(aAttr.name);
            this._applyAttributes(aVal, attr, doMods, undoMods);
            this.undo.do(function() {
              doMods.apply();
            }, function() {
              undoMods.apply();
            });
          } catch(ex) {
            dump(ex);
            Cu.reportError(ex);
          }
        }.bind(this)
      });

      this.attrs[aAttr.name] = attr;
    }

    name.textContent = aAttr.name;
    val.textContent = aAttr.value;

    return attr;
  },

  /**
   * Parse a user-entered attribute string and apply the resulting
   * attributes to the node.  This operation is undoable.
   *
   * @param string aValue the user-entered value.
   * @param Element aAttrNode the attribute editor that created this
   *        set of attributes, used to place new attributes where the
   *        user put them.
   * @throws SYNTAX_ERR if aValue is not well-formed.
   */
  _applyAttributes: function EE__applyAttributes(aValue, aAttrNode, aDoMods, aUndoMods)
  {
    // Create a dummy node for parsing the attribute list.
    let dummyNode = this.doc.createElement("div");

    let parseTag = (this.node.namespaceURI.match(/svg/i) ? "svg" :
                   (this.node.namespaceURI.match(/mathml/i) ? "math" : "div"));
    let parseText = "<" + parseTag + " " + aValue + "/>";
    // Throws exception if parseText is not well-formed.
    dummyNode.innerHTML = parseText;
    let parsedNode = dummyNode.firstChild;

    let attrs = parsedNode.attributes;

    for (let i = 0; i < attrs.length; i++) {
      // Create an attribute editor next to the current attribute if needed.
      this._createAttribute(attrs[i], aAttrNode ? aAttrNode.nextSibling : null);

      this._saveAttribute(attrs[i].name, aUndoMods);
      aDoMods.setAttribute(attrs[i].name, attrs[i].value);
    }
  },

  /**
   * Saves the current state of the given attribute into an attribute
   * modification list.
   */
  _saveAttribute: function(aName, aUndoMods)
  {
    let node = this.node;
    if (node.hasAttribute(aName)) {
      let oldValue = node.getAttribute(aName);
      aUndoMods.setAttribute(aName, oldValue);
    } else {
      aUndoMods.removeAttribute(aName);
    }
  },

  /**
   * Called when the tag name editor has is done editing.
   */
  onTagEdit: function EE_onTagEdit(aVal, aCommit) {
    if (!aCommit || aVal == this.node.tagName) {
      return;
    }

    // Create a new element with the same attributes as the
    // current element and prepare to replace the current node
    // with it.
    try {
      // XXX: needs serious work for DOMWalker
      var newElt = nodeDocument(this.rawNode).createElement(aVal);
      var newRef = this.markup.walker.importRaw(newElt);
    } catch(x) {
      // Failed to create a new element with that tag name, ignore
      // the change.
      return;
    }

    let attrs = this.node.attributes;

    for (let i = 0 ; i < attrs.length; i++) {
      newElt.setAttribute(attrs[i].name, attrs[i].value);
    }

    function swapNodes(aOld, aNew) {
      while (aOld.firstChild) {
        aNew.appendChild(aOld.firstChild);
      }
      aOld.parentNode.insertBefore(aNew, aOld);
      aOld.parentNode.removeChild(aOld);
    }

    let markup = this.container.markup;

    // Queue an action to swap out the element.
    this.undo.do(function() {
      swapNodes(this.rawNode, newElt);

      // Make sure the new node is imported and is expanded/selected
      // the same as the current node.
      let newContainer = markup.importNode(newRef);
      if (this.container.expanded) {
        this.markup._expandContainer(newContainer);
      } else {
        this.markup.collapseNode(newContainer.node);
      }
      if (this.container.selected) {
        markup.navigate(newContainer);
      }
    }.bind(this), function() {
      swapNodes(newElt, this.rawNode);

      let newContainer = markup._containers.get(newRef);
      if (newContainer.expanded) {
        this.markup._expandContainer(this.container);
      } else {
        this.markup.collapseNode(this.container.node);
      }
      if (newContainer.selected) {
        markup.navigate(this.container);
      }
    }.bind(this));
  },
}



RootContainer.prototype = {
  hasChildren: true,
  expanded: true,
  update: function RC_update() {}
};

function nodeDocument(node) {
  return node.ownerDocument || (node.nodeType == Ci.nsIDOMNode.DOCUMENT_NODE ? node : null);
}

function promisePass(r) {
  return r;
}

function promiseError(ex) {
  dump(ex + "\n");
  dump(ex.stack);
  Services.console.logStringMessage(ex);
  return ex;
}

// Temp import waiting for jetpack update.

var promised = (function() {
  // Note: Define shortcuts and utility functions here in order to avoid
  // slower property accesses and unnecessary closure creations on each
  // call of this popular function.

  var call = Function.call
  var concat = Array.prototype.concat

  // Utility function that does following:
  // execute([ f, self, args...]) => f.apply(self, args)
  function execute(args) { return call.apply(call, args) }

  // Utility function that takes promise of `a` array and maybe promise `b`
  // as arguments and returns promise for `a.concat(b)`.
  function promisedConcat(promises, unknown) {
    return promises.then(function(values) {
      return promise.resolve(unknown).then(function(value) {
        return values.concat([ value ])
      })
    })
  }

  return function promised(f, prototype) {
    /**
Returns a wrapped `f`, which when called returns a promise that resolves to
`f(...)` passing all the given arguments to it, which by the way may be
promises. Optionally second `prototype` argument may be provided to be used
a prototype for a returned promise.

## Example

var promise = promised(Array)(1, promise(2), promise(3))
promise.then(console.log) // => [ 1, 2, 3 ]
**/

    return function promised() {
      // create array of [ f, this, args... ]
      return concat.apply([ f, this ], arguments).
        // reduce it via `promisedConcat` to get promised array of fulfillments
        reduce(promisedConcat, promise.resolve([], prototype)).
        // finally map that to promise of `f.apply(this, args...)`
        then(execute)
    }
  }
})()

XPCOMUtils.defineLazyGetter(MarkupView.prototype, "strings", function () {
  return Services.strings.createBundle(
          "chrome://browser/locale/devtools/inspector.properties");
});
