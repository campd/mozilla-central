/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cc = Components.classes;
const Cu = Components.utils;
const Ci = Components.interfaces;

const PSEUDO_CLASSES = [":hover", ":active", ":focus"];

this.EXPORTED_SYMBOLS = ["HTMLBreadcrumbs"];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/devtools/DOMHelpers.jsm");
Cu.import("resource:///modules/devtools/LayoutHelpers.jsm");

let obj = {};
Cu.import('resource://gre/modules/commonjs/loader.js', obj);
let {Loader, Require, unload} = obj.Loader;
let loader = new Loader({
  paths: {
    'commonjs/': 'resource://gre/modules/commonjs/',
    '': 'resource:///modules/',
  }
});
let require = Require(loader, {id: "breadcrumbs"});

let promise = require("commonjs/promise/core");

const LOW_PRIORITY_ELEMENTS = {
  "HEAD": true,
  "BASE": true,
  "BASEFONT": true,
  "ISINDEX": true,
  "LINK": true,
  "META": true,
  "SCRIPT": true,
  "STYLE": true,
  "TITLE": true,
};

function promiseError(ex) {
  dump(ex + "\n");
  dump(ex.stack);
//  Services.console.logStringMessage(ex);
}

///////////////////////////////////////////////////////////////////////////
//// HTML Breadcrumbs

/**
 * Display the ancestors of the current node and its children.
 * Only one "branch" of children are displayed (only one line).
 *
 * Mechanism:
 * . If no nodes displayed yet:
 *    then display the ancestor of the selected node and the selected node;
 *   else select the node;
 * . If the selected node is the last node displayed, append its first (if any).
 */
this.HTMLBreadcrumbs = function HTMLBreadcrumbs(aInspector)
{
  this.inspector = aInspector;
  this.selection = this.inspector.selection;
  this.chromeWin = this.inspector.panelWin;
  this.chromeDoc = this.inspector.panelDoc;
  this.DOMHelpers = new DOMHelpers(this.chromeWin);
  this._init();
}

HTMLBreadcrumbs.prototype = {
  _init: function BC__init()
  {
    this.container = this.chromeDoc.getElementById("inspector-breadcrumbs");
    this.container.addEventListener("mousedown", this, true);
    this.container.addEventListener("keypress", this, true);

    // We will save a list of already displayed nodes in this array.
    this.nodeHierarchy = [];

    // Last selected node in nodeHierarchy.
    this.currentIndex = -1;

    // By default, hide the arrows. We let the <scrollbox> show them
    // in case of overflow.
    this.container.removeAttribute("overflows");
    this.container._scrollButtonUp.collapsed = true;
    this.container._scrollButtonDown.collapsed = true;

    this.onscrollboxreflow = function() {
      if (this.container._scrollButtonDown.collapsed)
        this.container.removeAttribute("overflows");
      else
        this.container.setAttribute("overflows", true);
    }.bind(this);

    this.container.addEventListener("underflow", this.onscrollboxreflow, false);
    this.container.addEventListener("overflow", this.onscrollboxreflow, false);

    this.update = this.update.bind(this);
    this.updateSelectors = this.updateSelectors.bind(this);
    this.selection.on("new-node", this.update);
    this.selection.on("pseudoclass", this.updateSelectors);
    this.selection.on("attribute-changed", this.updateSelectors);
    this.update();
  },

  /**
   * Build a string that represents the node: tagName#id.class1.class2.
   *
   * @param aNode The node to pretty-print
   * @returns a string
   */
  prettyPrintNodeAsText: function BC_prettyPrintNodeText(aNode)
  {
    let text = aNode.tagName.toLowerCase();
    if (aNode.id) {
      text += "#" + aNode.id;
    }
    for (let i = 0; i < aNode.classList.length; i++) {
      text += "." + aNode.classList[i];
    }
    for (let i = 0; i < PSEUDO_CLASSES.length; i++) {
      let pseudo = PSEUDO_CLASSES[i];
      if (aNode.hasPseudoClassLock(pseudo)) {
        text += pseudo;
      }
    }

    return text;
  },


  /**
   * Build <label>s that represent the node:
   *   <label class="inspector-breadcrumbs-tag">tagName</label>
   *   <label class="inspector-breadcrumbs-id">#id</label>
   *   <label class="inspector-breadcrumbs-classes">.class1.class2</label>
   *
   * @param aNode The node to pretty-print
   * @returns a document fragment.
   */
  prettyPrintNodeAsXUL: function BC_prettyPrintNodeXUL(aNode)
  {
    let fragment = this.chromeDoc.createDocumentFragment();

    let tagLabel = this.chromeDoc.createElement("label");
    tagLabel.className = "inspector-breadcrumbs-tag plain";

    let idLabel = this.chromeDoc.createElement("label");
    idLabel.className = "inspector-breadcrumbs-id plain";

    let classesLabel = this.chromeDoc.createElement("label");
    classesLabel.className = "inspector-breadcrumbs-classes plain";

    let pseudosLabel = this.chromeDoc.createElement("label");
    pseudosLabel.className = "inspector-breadcrumbs-pseudo-classes plain";

    tagLabel.textContent = aNode.tagName.toLowerCase();
    idLabel.textContent = aNode.id ? ("#" + aNode.id) : "";

    let classesText = "";
    for (let i = 0; i < aNode.classList.length; i++) {
      classesText += "." + aNode.classList[i];
    }
    classesLabel.textContent = classesText;

    let pseudos = PSEUDO_CLASSES.filter(function(pseudo) {
      return aNode.hasPseudoClassLock(pseudo);
    }, this);
    pseudosLabel.textContent = pseudos.join("");

    fragment.appendChild(tagLabel);
    fragment.appendChild(idLabel);
    fragment.appendChild(classesLabel);
    fragment.appendChild(pseudosLabel);

    return fragment;
  },

  /**
   * Open the sibling menu.
   *
   * @param aButton the button representing the node.
   * @param aNode the node we want the siblings from.
   */
  openSiblingMenu: function BC_openSiblingMenu(aButton, aNode)
  {
    // We make sure that the targeted node is selected
    // because we want to use the nodemenu that only works
    // for inspector.selection
    this.selection.setNodeRef(aNode, "breadcrumbs");

    // XXX: this isn't a 100% kosher way to get the parent node synchronously.
    this.walker.children(this.walker._ref(aNode.parentKey), {
      maxChildren: 20,
      include: aNode,
      whatToShow: Ci.nsIDOMNodeFilter.SHOW_ELEMENT,
    }).then(function(children) {
      let nodes = children.children;
      // XXX: we might not have gotten the complete list (children.atFirst
      // or children.atLast might be false).  We might want to do something
      // in that case.
      let title = this.chromeDoc.createElement("menuitem");
      title.setAttribute("label", this.inspector.strings.GetStringFromName("breadcrumbs.siblings"));
      title.setAttribute("disabled", "true");

      let separator = this.chromeDoc.createElement("menuseparator");

      let items = [title, separator];

      for (let i = 0; i < nodes.length; i++) {
        let item = this.chromeDoc.createElement("menuitem");
        if (nodes[i] === aNode) {
          item.setAttribute("disabled", "true");
          item.setAttribute("checked", "true");
        }

        item.setAttribute("type", "radio");
        item.setAttribute("label", this.prettyPrintNodeAsText(nodes[i]));

        let selection = this.selection;
        item.onmouseup = (function(aNode) {
          return function() {
            selection.setNodeRef(aNode, "breadcrumbs");
          }
        })(nodes[i]);

        items.push(item);
      }
      this.inspector.showNodeMenu(aButton, "before_start", items);
    }.bind(this)).then(null, promiseError);
  },

  /**
   * Generic event handler.
   *
   * @param nsIDOMEvent event
   *        The DOM event object.
   */
  handleEvent: function BC_handleEvent(event)
  {
    if (event.type == "mousedown" && event.button == 0) {
      // on Click and Hold, open the Siblings menu

      let timer;
      let container = this.container;

      function openMenu(event) {
        cancelHold();
        let target = event.originalTarget;
        if (target.tagName == "button") {
          target.onBreadcrumbsHold();
        }
      }

      function handleClick(event) {
        cancelHold();
        let target = event.originalTarget;
        if (target.tagName == "button") {
          target.onBreadcrumbsClick();
        }
      }

      let window = this.chromeWin;
      function cancelHold(event) {
        window.clearTimeout(timer);
        container.removeEventListener("mouseout", cancelHold, false);
        container.removeEventListener("mouseup", handleClick, false);
      }

      container.addEventListener("mouseout", cancelHold, false);
      container.addEventListener("mouseup", handleClick, false);
      timer = window.setTimeout(openMenu, 500, event);
    }

    if (event.type == "keypress" && this.selection.isElementNode()) {
      let node = null;
      switch (event.keyCode) {
        case this.chromeWin.KeyEvent.DOM_VK_LEFT:
          if (this.currentIndex != 0) {
            node = promise.resolve(this.nodeHierarchy[this.currentIndex - 1].node);
          }
          break;
        case this.chromeWin.KeyEvent.DOM_VK_RIGHT:
          if (this.currentIndex < this.nodeHierarchy.length - 1) {
            node = promise.resolve(this.nodeHierarchy[this.currentIndex + 1].node);
          }
          break;
        case this.chromeWin.KeyEvent.DOM_VK_UP:
          node = this.walker.previousSibling(this.selection.nodeRef, {
            whatToShow: Ci.nsIDOMNodeFilter.SHOW_ELEMENT
          });
          break;
        case this.chromeWin.KeyEvent.DOM_VK_DOWN:
          node = this.walker.nextSibling(this.selection.nodeRef, {
            whatToShow: Ci.nsIDOMNodeFilter.SHOW_ELEMENT
          });
          break;
      }

      if (node) {
        node.then(function(node) {
          this.selection.setNodeRef(node, "breadcrumbs");
        }.bind(this)).then(null, promiseError);
      }
      event.preventDefault();
      event.stopPropagation();
    }
  },

  /**
   * Remove nodes and delete properties.
   */
  destroy: function BC_destroy()
  {
    let crumb = this.nodeHierarchy[this.nodeHierarchy.length  - 1];
    this.walker.clearPseudoClassLocks(crumb.node, {
      all: true
    });

    this.selection.off("new-node", this.update);
    this.selection.off("pseudoclass", this.updateSelectors);
    this.selection.off("attribute-changed", this.updateSelectors);

    this.container.removeEventListener("underflow", this.onscrollboxreflow, false);
    this.container.removeEventListener("overflow", this.onscrollboxreflow, false);
    this.onscrollboxreflow = null;

    this.empty();
    this.container.removeEventListener("mousedown", this, true);
    this.container.removeEventListener("keypress", this, true);
    this.container = null;
    this.nodeHierarchy = null;
  },

  /**
   * Empty the breadcrumbs container.
   */
  empty: function BC_empty()
  {
    while (this.container.hasChildNodes()) {
      this.container.removeChild(this.container.firstChild);
    }
  },

  /**
   * Re-init the cache and remove all the buttons.
   */
  invalidateHierarchy: function BC_invalidateHierarchy()
  {
    this.inspector.hideNodeMenu();
    this.nodeHierarchy = [];
    this.empty();
  },

  /**
   * Set which button represent the selected node.
   *
   * @param aIdx Index of the displayed-button to select
   */
  setCursor: function BC_setCursor(aIdx)
  {
    // Unselect the previously selected button
    if (this.currentIndex > -1 && this.currentIndex < this.nodeHierarchy.length) {
      this.nodeHierarchy[this.currentIndex].button.removeAttribute("checked");
    }
    if (aIdx > -1) {
      this.nodeHierarchy[aIdx].button.setAttribute("checked", "true");
      if (this.hadFocus)
        this.nodeHierarchy[aIdx].button.focus();
    }
    this.currentIndex = aIdx;
  },

  /**
   * Get the index of the node in the cache.
   *
   * @param aNode
   * @returns integer the index, -1 if not found
   */
  indexOf: function BC_indexOf(aNode)
  {
    let i = this.nodeHierarchy.length - 1;
    for (let i = this.nodeHierarchy.length - 1; i >= 0; i--) {
      if (this.nodeHierarchy[i].node === aNode) {
        return i;
      }
    }
    return -1;
  },

  /**
   * Remove all the buttons and their references in the cache
   * after a given index.
   *
   * @param aIdx
   */
  cutAfter: function BC_cutAfter(aIdx)
  {
    while (this.nodeHierarchy.length > (aIdx + 1)) {
      let toRemove = this.nodeHierarchy.pop();
      this.container.removeChild(toRemove.button);
    }
  },

  /**
   * Build a button representing the node.
   *
   * @param aNode The node from the page.
   * @returns aNode The <button>.
   */
  buildButton: function BC_buildButton(aNode)
  {
    let button = this.chromeDoc.createElement("button");
    button.appendChild(this.prettyPrintNodeAsXUL(aNode));
    button.className = "inspector-breadcrumbs-button";

    button.setAttribute("tooltiptext", this.prettyPrintNodeAsText(aNode));

    button.onkeypress = function onBreadcrumbsKeypress(e) {
      if (e.charCode == Ci.nsIDOMKeyEvent.DOM_VK_SPACE ||
          e.keyCode == Ci.nsIDOMKeyEvent.DOM_VK_RETURN)
        button.click();
    }

    button.onBreadcrumbsClick = function onBreadcrumbsClick() {
      this.selection.setNodeRef(aNode, "breadcrumbs");
    }.bind(this);

    button.onclick = (function _onBreadcrumbsRightClick(event) {
      button.focus();
      if (event.button == 2) {
        this.openSiblingMenu(button, aNode);
      }
    }).bind(this);

    button.onBreadcrumbsHold = (function _onBreadcrumbsHold() {
      this.openSiblingMenu(button, aNode);
    }).bind(this);
    return button;
  },

  /**
   * Connecting the end of the breadcrumbs to a node.
   *
   * @param aNodes The node to reach and its parents.
   */
  expand: function BC_expand(aNodes)
  {
    let toAppend = aNodes.shift();
    let fragment = this.chromeDoc.createDocumentFragment();
    let lastButtonInserted = null;
    let originalLength = this.nodeHierarchy.length;
    let stopNode = null;
    if (originalLength > 0) {
      stopNode = this.nodeHierarchy[originalLength - 1].node;
    }
    while (toAppend && toAppend.tagName && toAppend != stopNode) {
      let button = this.buildButton(toAppend);
      fragment.insertBefore(button, lastButtonInserted);
      lastButtonInserted = button;
      this.nodeHierarchy.splice(originalLength, 0, {node: toAppend, button: button});
      toAppend = aNodes.shift();
    }
    this.container.appendChild(fragment, this.container.firstChild);
  },

  /**
   * Get a child of a node that can be displayed in the breadcrumbs
   * and that is probably visible. See LOW_PRIORITY_ELEMENTS.
   *
   * @param aNode The parent node.
   * @returns nsIDOMNode|null
   */
  getInterestingFirstNode: function BC_getInterestingFirstNode(aNode)
  {
    // XXX: no first node in remote cases for now.
    if (!aNode._rawNode) {
      return null;
    }
    aNode = aNode._rawNode;

    let nextChild = this.DOMHelpers.getChildObject(aNode, 0);
    let fallback = null;

    while (nextChild) {
      if (nextChild.nodeType == aNode.ELEMENT_NODE) {
        if (!(nextChild.tagName in LOW_PRIORITY_ELEMENTS)) {
          return this.walker._ref(nextChild);
        }
        if (!fallback) {
          fallback = nextChild;
        }
      }
      nextChild = this.DOMHelpers.getNextSibling(nextChild);
    }
    return fallback ? this.walker._ref(fallback) : null;
  },


  /**
   * Find the "youngest" ancestor of a node which is already in the breadcrumbs.
   *
   * @param aNode
   * @returns Index of the ancestor in the cache
   */
  getCommonAncestor: function BC_getCommonAncestor(aParents)
  {
    for (let i = 0; i < aParents.length; i++) {
      let crumbIdx = this.indexOf(aParents[i]);
      if (crumbIdx > -1) {
        return crumbIdx;
      }
    }

    return -1;
  },

  /**
   * Make sure that the latest node in the breadcrumbs is not the selected node
   * if the selected node still has children.
   */
  ensureFirstChild: function BC_ensureFirstChild()
  {
    // If the last displayed node is the selected node
    if (this.currentIndex == this.nodeHierarchy.length - 1) {
      let node = this.nodeHierarchy[this.currentIndex].node;
      let child = this.getInterestingFirstNode(node);
      // If the node has a child
      if (child) {
        // Show this child
        this.expand([child]);
      }
    }
  },

  /**
   * Ensure the selected node is visible.
   */
  scroll: function BC_scroll()
  {
    // FIXME bug 684352: make sure its immediate neighbors are visible too.

    let scrollbox = this.container;
    let element = this.nodeHierarchy[this.currentIndex].button;
    scrollbox.ensureElementIsVisible(element);
  },

  updateSelectors: function BC_updateSelectors()
  {
    for (let i = this.nodeHierarchy.length - 1; i >= 0; i--) {
      let crumb = this.nodeHierarchy[i];
      let button = crumb.button;

      while(button.hasChildNodes()) {
        button.removeChild(button.firstChild);
      }
      button.appendChild(this.prettyPrintNodeAsXUL(crumb.node));
      button.setAttribute("tooltiptext", this.prettyPrintNodeAsText(crumb.node));
    }
  },

  /**
   * Update the breadcrumbs display when a new node is selected.
   */
  update: function BC_update()
  {
    this.walker = this.inspector.walker;

    this.inspector.hideNodeMenu();

    let cmdDispatcher = this.chromeDoc.commandDispatcher;
    this.hadFocus = (cmdDispatcher.focusedElement &&
                     cmdDispatcher.focusedElement.parentNode == this.container);

    if (!this.selection.isConnected()) {
      this.cutAfter(-1); // remove all the crumbs
      return;
    }

    if (!this.selection.isElementNode()) {
      this.setCursor(-1); // no selection
      return;
    }

    let idx = this.indexOf(this.selection.nodeRef);

    // Is the node already displayed in the breadcrumbs?
    if (idx > -1) {
      // Yes. We select it.
      this.setCursor(idx);

      // XXX: we can fix the code duplication here.

      dump("Ensuring first child here (sync)\n");
      // Add the first child of the very last node of the breadcrumbs if possible.
      this.ensureFirstChild();

      // Make sure the selected node and its neighbours are visible.
      this.scroll();

      this.updateSelectors();
    } else {
      this.walker.parents(this.selection.nodeRef).then(function(parents) {
        dump("Node has " + parents.length + " parents.\n");
        // No. Is the breadcrumbs display empty?
        if (this.nodeHierarchy.length > 0) {
          // No. We drop all the element that are not direct ancestors
          // of the selection
          let idx = this.getCommonAncestor(parents);
          this.cutAfter(idx);
        }

        // we append the missing button between the end of the breadcrumbs display
        // and the current node.
        parents.unshift(this.selection.nodeRef);
        this.expand(parents);

        // we select the current node button
        idx = this.indexOf(this.selection.nodeRef);
        this.setCursor(idx);
        // XXX: We can fix the code duplication here.

        dump("About to ensure first child (async)\n");
        // Add the first child of the very last node of the breadcrumbs if possible.
        this.ensureFirstChild();
        dump("Done ensuring first child.\n");

        // Make sure the selected node and its neighbours are visible.
        this.scroll();

        this.updateSelectors();
      }.bind(this)).then(null, promiseError);
    }
  },
}

XPCOMUtils.defineLazyGetter(this, "DOMUtils", function () {
  return Cc["@mozilla.org/inspector/dom-utils;1"].getService(Ci.inIDOMUtils);
});
