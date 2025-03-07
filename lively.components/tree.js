/*global Map,WeakMap*/
import { arr, fun, obj, tree, string, promise } from "lively.lang";
import { pt, Rectangle, Color } from "lively.graphics";
import { Label } from "lively.morphic/text/label.js";
import { Morph, Text, config, StyleSheet } from "lively.morphic";
import { connect, signal } from "lively.bindings";

/*

This module provides a tree widget to display hierarchical data. The tree data passed to the tree can be arbitrary and should be wrapped into a TreeData object. Besides the main tree structure this object receives a function to extract a name from a tree node

var root = new (class extends TreeData {
  display(node) { return node.name }
  isCollapsed(node) { return node.isCollapsed }
  collapse(node, bool) { node.isCollapsed = bool; }
  getChildren(node) { return node.isLeaf ? null : node.isCollapsed ? [] : node.children }
  isLeaf(node) { return node.isLeaf }
})({
  name: "root",
  isCollapsed: false,
  isLeaf: false,
  children: [
    {name: "child 1", isLeaf: true},
    {name: "child 2", isLeaf: false, isCollapsed: true, children: [{name: "child 2 - 1", isLeaf: true}]},
    {name: "child 3", isLeaf: false,
     isCollapsed: false,
     children: [
       {name: "child 3 - 1", isLeaf: true},
       {name: "child 3 - 2", isLeaf: true}
     ]},
    {name: "child 4", isLeaf: true},
  ]
});

var treeMorph = new Tree({
  extent: pt(200,70), fill: Color.white, border: {color: Color.gray, width: 1},
  treeData: root
}).openInWorld();

*/

export class Tree extends Text {

  static get properties() {

    return {
      styleSheets: {
        after: ['selectionColor', 'selectionFontColor', 'nonSelectionFontColor', 'fontColor'],
        initialize() {
          this.updateStyleSheet();
        }
      },
      selectionColor: {
        type: 'ColorGradient',
        defaultValue: Color.blue,
      },
      fontFamily: {defaultValue: config.codeEditor.defaultStyle.fontFamily},
      nativeCursor: {defaultValue: 'auto'},
      selectable: {defaultValue: false},
      acceptsDrops: {defaultValue: false},
      readOnly: {defaultValue: true},
      fixedWidth: {defaultValue: true},
      fixedHeight: {defaultValue: true},
      lineHeight: {
        defaultValue: 1.5
      },
      clipMode: {defaultValue: "auto"},
      padding: {defaultValue: Rectangle.inset(3)},

      resizeNodes: {
        defaultValue: false,
        set(val) { this.setProperty("resizeNodes", val); this.resetCache(); this.update(); }
      },

      treeData: {
        after: ['selection'],
        set(val) { this.setProperty("treeData", val); this.resetCache(); this.update(); }
      },

      selectedIndex: {
        derived: true, after: ["selectedNode", "nodes"],
        get() { return this.selectedNode ? this.nodes.indexOf(this.selectedNode) : -1; },
        set(i) { this.selectedNode = this.nodes[i]; }
      },

      nodes: {
        derived: true, after: ["treeData"],
        get() { return this.treeData.asList(); },
      },

      defaultViewState: {
        get() {
          return {...super.prototype.defaultViewState, fastScroll: false }
        }
      },

      selectedNode: {
        set(sel) { 
          this.setProperty("selectedNode", sel); 
          this.update(); 
        }
      },

      selectedNodeAndSiblings: {
        readOnly: true, derived: true, after: ["selectedNode", "treeData"],
        get() {
          return this.selectedNode ?
            this.treeData.nodeWithSiblings(this.selectedNode) : [];
        },
      },

      selectionFontColor: {
        isStyleProp: true,
        defaultValue: Color.white,
        set(c) {
          this.setProperty('selectionFontColor', c);
        }
      },

      nonSelectionFontColor: {
        isStyleProp: true,
        defaultValue: Color.rgbHex('333'),
        set(c) {
          this.setProperty('nonSelectionFontColor', c);
        }
      },

      nodeItemContainer: {
        derived: true, readOnly: true, after: ["submorphs"],
        get() { return this; },
      },

      nodeMorphs: {
        derived: true, readOnly: true, after: ["submorphs"],
        get() { return this.nodeItemContainer.submorphs.slice(); }
      }

    };
  }

  updateStyleSheet() {
    this.styleSheets = new StyleSheet({
      ".TreeNode .PropertyControl": {
        fontSize: this.fontSize,
        fontColor: this.fontColor
      },
      ".TreeNode .TreeLabel": {
        fontSize: this.fontSize
      },
      ".TreeNode.deselected": {
        fill: Color.transparent
      },
      ".TreeNode.selected": {
        fill: this.selectionColor
      },
      ".TreeNode.selected .TreeLabel": {
        fontColor: this.selectionFontColor,
        borderColor:  this.selectionFontColor
      },
      ".TreeNode.deselected .TreeLabel": {
        fontColor: this.nonSelectionFontColor,
        borderColor:  this.nonSelectionFontColor
      }
    });
  }

  constructor(props = {}) {
    if (!props.treeData)
      throw new Error("Cannot create tree without TreeData!");
    super(props);
    this.resetCache();
    this.update();
    this.selectionColor = props.selectionColor || Color.blue;
  }

  onChange(change) {
    super.onChange(change);
    if (['fontSize', 'fontColor', 'selectionColor', 
         'nonSelectionFontColor', 'selectionFontColor'].includes(change.prop)) {
      this.updateStyleSheet();
      this.update(true);
    }
  }

  resetCache() { this._lineHeightCache = null; }

  get isTree() { return true; }

  get nodeStyle() {
    return {
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontWeight: this.fontWeight,
      autofit: !this.resizeNodes
    };
  }

  lineBounds(idx) {
    var charBounds = this.textLayout.charBoundsOfRow(this, idx),
        tl = Rectangle.fromLiteral(arr.first(charBounds)).topLeft(),
        br = Rectangle.fromLiteral(arr.last(charBounds)).bottomRight();
    return Rectangle.fromAny(tl, br)
  }

  recoverOriginalLine(row) {
    let attrs = this.document.getTextAndAttributesOfLine(row);
    for (let i = 0; i < attrs.length; i++) {
      let fontColor = this._originalColor[i];
      if (!fontColor || obj.isString(attrs[i])) continue;
      if (attrs[i]) 
        attrs[i].fontColor = fontColor;
      else
        attrs[i] = {fontColor}
    }
    this.document.setTextAndAttributesOfLine(row, attrs)
  }

  renderSelectedLine(row) {
    let attrs = this.document.getTextAndAttributesOfLine(row);
    this._originalColor = new Array(attrs.length);
    for (let i = 0; i < attrs.length; i++) {
      if ((i % 2) === 0) {
        if (attrs[i] && attrs[i].isMorph) {
          this._originalColor[i] = attrs[i] ? attrs[i].fontColor || this.nonSelectionFontColor : null
          attrs[i].fontColor = this.selectionFontColor;
          attrs[i].isSelected = true;
          continue;
        } else {
          continue;
        }
      }
      this._originalColor[i] = (attrs[i] ? attrs[i].fontColor : null) || this.nonSelectionFontColor
      if (attrs[i])
        attrs[i].fontColor = this.selectionFontColor;
      else
        attrs[i] = {fontColor: this.selectionFontColor};
    }
    this.document.setTextAndAttributesOfLine(row, attrs)
    this.selectLine(row, true);
    this._lastSelectedIndex = this.selectedIndex;
  }

  computeTreeAttributes(nodes) {
    if (!nodes.length) return [];
    var containerTextAndAttributes = arr.genN(8 * (nodes.length - 1), () => null), 
        i = 1, j, isSelected, toggleWidth = this.fontSize * 1.3;
    for (; i < nodes.length; i++) {
      j = 8 * (i - 1);
      isSelected = this.selectedIndex == i;
      nodes[i].node.isSelected = isSelected;
      // indent 
      containerTextAndAttributes[j] = " ";
      containerTextAndAttributes[j + 1] = {
        fontSize: toggleWidth,
        fontColor: Color.transparent, 
        textStyleClasses: ['fa'],
        paddingRight: (toggleWidth * (nodes[i].depth - 1)) + 'px'
      };
      // toggle
      containerTextAndAttributes[j + 3] = {
        fontColor: Color.transparent, 
        textStyleClasses: ['fa'],
        paddingTop: (this.fontSize / 10) + 'px',
        paddingRight: (this.fontSize / 8) + 'px'
      };
      if (!this.treeData.isLeaf(nodes[i].node)) {
         containerTextAndAttributes[j + 2] = this.treeData.isCollapsed(nodes[i].node) ? " \uf196 " : " \uf147 "; 
         Object.assign(
            containerTextAndAttributes[j + 3], {
              nativeCursor: 'pointer',
              fontColor: this.fontColor
         })
      } else {
         containerTextAndAttributes[j + 2] = "     "; 
      }
      // node
      let displayedNode = this.treeData.safeDisplay(nodes[i].node);
      if (displayedNode.isMorph) {
        if (displayedNode._capturedProps)
              Object.assign(displayedNode, displayedNode._capturedProps);
        if (isSelected) {
          displayedNode._capturedProps  = obj.select(displayedNode,['fontColor']);
        }
        displayedNode.fontColor = this.nonSelectionFontColor;
      }

      containerTextAndAttributes[j + 4] = displayedNode;
      if (arr.isArray(displayedNode)) {
        containerTextAndAttributes[j + 5] = []
      } else {
        containerTextAndAttributes[j + 5] = {
          fontColor: this.fontColor
        };
      }
      containerTextAndAttributes[j + 6] = '\n';
      containerTextAndAttributes[j + 7] = {};
    }
    containerTextAndAttributes.push(' ', {
      fontSize: this.fontSize * 1.3,
      textStyleClasses: ['fa']
    });
    return nodes.length > 1 ? arr.flatten(containerTextAndAttributes) : []
  }

  update(force) {
    // fixme: this method should only be used in cases, where the tree data is replaced.
    //        When collapsing/uncollapsing nodes, we should insert, remove ranges of the text
    //        which makes for a faster rendering of the tree.
    if (this._updating || !this.treeData || !this.nodeItemContainer) return;
    this._updating = true;
    
    this.withMetaDo({isLayoutAction: true}, () => {
      let {
            treeData,
            padding,
            extent,
            resizeNodes,
            nodeMorphs,
            selectedNode
          } = this,
          nodes = treeData.asListWithIndexAndDepth(),
          treeDataRestructured = this.treeData !== this.lastTreeData || 
                                 this.lastNumberOfNodes !== nodes.length;
      
      var row, attrs;
      if (treeDataRestructured || force) {
        this.replace(
           {start: {row: 0, column: 0}, 
            end: this.documentEndPosition}, 
            this.computeTreeAttributes(nodes),
            false, false);
        this.invalidateTextLayout(true, false);
        this.whenRendered().then(async () => {
           this.makeDirty();
        });
      } else if (this._lastSelectedIndex) {
        this.recoverOriginalLine(this._lastSelectedIndex - 1);
      }
      this.lastTreeData = this.treeData;
      this.lastNumberOfNodes = nodes.length;
      this.cursorPosition = {row: 0, column: 0};
      if (this.selectedIndex > -1) {
        this.renderSelectedLine(this.selectedIndex - 1);
      }
    });
    this._updating = false;
  }
  
  buildViewState(nodeIdFn) {
    if (typeof nodeIdFn !== "function")
      nodeIdFn = node => node;

    var selId = this.selectedNode ? nodeIdFn(this.selectedNode) : null,
        collapsedMap = new Map();

    tree.prewalk(this.treeData.root,
      node => collapsedMap.set(nodeIdFn(node), this.treeData.isCollapsed(node)),
      node => this.treeData.getChildrenIfUncollapsed(node));

    return {
      selectionId: selId,
      collapsedMap,
      scroll: this.scroll
    };
  }

  async applyViewState(viewState, nodeIdFn) {
    if (typeof nodeIdFn !== "function")
      nodeIdFn = node => node;

    var { selectionId, collapsedMap, scroll } = viewState,
        i = 0, newSelIndex = -1;

    while (true) {
      var nodes = this.nodes;
      if (i >= nodes.length) break;
      var id = nodeIdFn(nodes[i]);
      if (selectionId === id) newSelIndex = i + 1;
      if (collapsedMap.has(id) && !collapsedMap.get(id))
        await this.treeData.collapse(nodes[i], false);
      i++;
    }
    this.selectedIndex = newSelIndex;
    this.update();
    this.scroll = scroll;
    this.scrollSelectionIntoView();
    await promise.delay(0);
  }

  async maintainViewStateWhile(whileFn, nodeIdFn) {
    // keeps the scroll, selection, and node collapse state, useful when updating the list
    // specify a nodeIdFn to compare old and new nodes, useful when you
    // generate a new tree but still want to have the same elements uncollapsed in
    // the new.

    var viewState = this.buildViewState(nodeIdFn);
    await whileFn();
    await this.applyViewState(viewState, nodeIdFn);
  }

  async onNodeCollapseChanged({node, isCollapsed}) {
    this.resetCache();
    try {
      await this.treeData.collapse(node, isCollapsed);
      signal(this, 'nodeCollapseChanged');
      this.update(); // this perform cut/paste of the node contents instead of a brute force update
    } catch (e) { this.showError(e); }
  }

  async uncollapse(node = this.selectedNode) {
    if (!node || !this.treeData.isCollapsed(node)) return;
    await this.onNodeCollapseChanged({node, isCollapsed: false});
    return node;
  }

  async collapse(node = this.selectedNode) {
    if (!node || this.treeData.isCollapsed(node)) return;
    await this.onNodeCollapseChanged({node, isCollapsed: true});
    return node;
  }

  selectedPath() { return this.treeData.pathOf(this.selectedNode); }

  async selectPath(path) { return this.selectedNode = await this.treeData.followPath(path); }

  gotoIndex(i) {
    this.selectedNode = this.nodes[i];
    this.scrollIndexIntoView(i);
  }

  scrollSelectionIntoView() {
    this.selectedNode && this.scrollIndexIntoView(this.selectedIndex);
  }

  scrollIndexIntoView(idx) { this.scrollToIndex(idx, "into view"); }

  centerSelection() {
    this.selectedNode && this.scrollToIndex(this.selectedIndex, "center");
  }

  scrollToIndex(idx) {
    this.scrollPositionIntoView({row: idx - 1, column: 0});
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // event handling
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  contextMenuForNode(node, evt) {
    signal(this, "contextMenuRequested", {node, evt});
  }

  onKeyDown(evt) {
    let w = this.world(),
        f = w.focusedMorph;
    // to not steal keys from inner morphs
    if (f.isText && !f.readOnly) return;
    return super.onKeyDown(evt);
  }
  
  async onMouseDown(evt) {
    //super.onMouseDown(evt);
    let {row, column} = this.textPositionFromPoint(evt.positionIn(this)),
        clickedNode = this.nodes[row + 1];
    if (!clickedNode) return;
    if (!this.treeData.isLeaf(clickedNode) && column < 4) {
      await clickedNode.isCollapsed ? 
        this.uncollapse(clickedNode) : 
        this.collapse(clickedNode);
    } else {
      if (this.selectedIndex != row + 1)
         this.selectedIndex = row + 1;
    }
  }

  onHoverIn(evt) {
    super.onHoverIn(evt);
    this.clipMode = 'auto';
  }

  onHoverOut(evt) {
    super.onHoverOut(evt);
    this.clipMode = 'hidden';
  }
  
  onContextMenu(evt) {
    if (evt.targetMorph !== this) return;
    evt.stop();
    let {row, column} = this.textPositionFromPoint(evt.positionIn(this)),
        clickedNode = this.nodes[row + 1];
    if (!clickedNode) return;
    this.contextMenuForNode(clickedNode, evt);
  }

  get keybindings() {
    return [
      {keys: "Up|Ctrl-P", command: "select node above"},
      {keys: "Down|Ctrl-N", command: "select node below"},

      {keys: "Left", command: "collapse selected node"},
      {keys: "Right", command: "uncollapse selected node"},

      {keys: "Alt-V|PageUp", command: "page up"},
      {keys: "Ctrl-V|PageDown", command: "page down"},

      {keys: "Alt-Shift-,", command: "goto first item"},
      {keys: "Alt-Shift-.", command: "goto last item"},

      {keys: "Alt-Space", command: "select via filter"},

      {keys: "Ctrl-L", command: "realign top-bottom-center"},

      {keys: {mac: "Meta-[", win: "Ctrl-["}, command: {command: "collapse or uncollapse all siblings", args: {what: "collapse"}}},
      {keys: {mac: "Meta-]", win: "Ctrl-]"}, command: {command: "collapse or uncollapse all siblings", args: {what: "uncollapse"}}},

      {keys: "Alt-N", command: "goto next sibling"},
      {keys: "Alt-P", command: "goto prev sibling"},
      {keys: "Alt-U", command: "goto parent"},
    ]
      //.concat(super.keybindings);
  }

  get commands() {
    return treeCommands;
  }

  highlightChangedNodes(treeData) {
    /* highlights all visible nodes that contain different information
       to their (location-wise) counterparts in 'treeData'. */
    let changedNodes = this.treeData.diff(treeData);
    changedNodes.forEach(([n,_]) => n.renderedNode && n.renderedNode.highlight());
  }

}


export class TreeData {

  constructor(root) {
    this.root = root;
    this.parentMap = new WeakMap();
  }

  get __dont_serialize__() { return ["parentMap"]; }
  __deserialize__() { this.parentMap = new WeakMap(); }

  display(node) { throw new Error("Not yet implemented"); }
  isCollapsed(node) { throw new Error("Not yet implemented"); }
  collapse(node, bool) { throw new Error("Not yet implemented"); }
  getChildren(node) { throw new Error("Not yet implemented"); }
  isLeaf(node) { throw new Error("Not yet implemented"); }

  getChildrenIfUncollapsed(node) {
    if (this.isCollapsed(node)) return []
    return this.getChildren(node);
  }

  safeDisplay(node) {
    try { return this.display(node); }
    catch (e) { return `[TreeData] Error when trying to display node: ${e}`;}
  }

  nodeToString(node) {
    // for extracting rich text in textAttributes format
    var value = this.safeDisplay(node);
    if (typeof value === "string") return value;
    if (!value || !Array.isArray(value)) return String(value);
    return value.map((text, i) => i%2===0? text: "").join("");
  }

  parentNode(childNode) {
    return this.parentMap.get(childNode) || tree.detect(this.root,
      node => !this.isLeaf(node) && this.getChildrenIfUncollapsed(node).includes(childNode),
      node => this.getChildrenIfUncollapsed(node));
  }

  nodeWithSiblings(node) {
    var parent = this.parentNode(node);
    return parent ? this.getChildrenIfUncollapsed(parent) : [];
  }

  asList() {
    return this.asListWithIndexAndDepth().map(ea => ea.node);
  }

  asListWithIndexAndDepth(filterFn = false) {
    var nodesWithIndex = [];
    tree.prewalk(this.root,
      (node, i, depth) => nodesWithIndex.push({node, depth, i}),
      (node) => this.getChildrenIfUncollapsed(node));
    return filterFn ? nodesWithIndex.filter(filterFn) : nodesWithIndex;
  }

  pathOf(node) {
    var path = [];
    while (node) { path.unshift(node); node = this.parentNode(node); }
    return path;
  }

  async followPath(path, eqFn, startNode = this.root) {
    // takes a path list that should denote a path into a node inside the tree.
    // path[n] does not necessarily be directly a node of treeData, when eqFn
    // is passed this fuction is used to find the right node for the path part
    // eqFn(pathPath, node) should return true if pathPart denotes node and
    // should be selected for the next descend step.
    //
    // Example:
    // // Let's use a tree of resources (lively.resource) describing a file system structure.
    // var target = resource("file://foo/bar/baz.js");
    // // assume that treeData.root.resource === resource("file://foo/");
    // var path = target.parents().concat(target)
    // var found = await td.followPath(path, (resource, node) => resource.equals(node.resource));
    // found.resource // => resource("file://foo/bar/baz.js")
    // // + the path to the node is now uncollapsed and e.g. can be selected via
    // tree.selection = found; tree.centerSelection();

    if (!eqFn) eqFn = (pathPart, node) => pathPart === node;

    var startIndex = path.findIndex(ea => eqFn(ea, startNode));
    path = path.slice(startIndex+1);

    if (!path.length) return null;

    var currentNode = startNode;
    while (true) {
      if (!path.length) break;

      if (this.isCollapsed(currentNode))
        await this.collapse(currentNode, false);

      var nextPathPart = path.shift(),
          nextNode = this.getChildrenIfUncollapsed(currentNode).find(ea => eqFn(nextPathPart, ea));

      if (!nextNode)
        throw new Error(`Cannot descend into tree, next node of ${path.join(".")} not found at ${this.safeDisplay(currentNode)}`);

      currentNode = nextNode;
    }

    return currentNode;
  }

  diff(treeData) {
    /* Returns the nodes that are different to the ones in 'treeData'.
       Once a node has been determined different, it is no longer traversed further
       which means that its children are not inspected for changes.  */
    let changedNodes = [],
        aList = this.asListWithIndexAndDepth(),
        bList = treeData.asListWithIndexAndDepth();
    if (aList.length != bList.length) return [];
    for (var [a, b] of arr.zip(aList, bList)) {
      if (!obj.equals(a.node.value, b && b.node.value)) changedNodes.push([a.node, b.node]);
    }
    return changedNodes;
  }

  patch(treeData) {
    /* change a tree in place, leaving all the unchanged nodes
       untouched */
    let changedNodes = this.diff(treeData);
    if (changedNodes.length > 0) {
      for (let [a, b] of changedNodes) {
        a.value = b.value;
      }
      return this;
    } else {
      return treeData;
    }
  }

  async uncollapseAll(iterator, depth=0, node) {
    if (!node) return await this.uncollapseAll(iterator, depth, this.root);
    if (iterator(node, depth)) {
      node.isCollapsed && await this.collapse(node, false);
      for (let i in node.children) {
        await this.uncollapseAll(iterator, depth + 1, node.children[i]);
      }
    }
  }

}

var treeCommands = [

  {
    name: "select via filter",
    exec: async tree => {
      var td = tree.treeData,
          nodes = td.asListWithIndexAndDepth(),
          data = td.asListWithIndexAndDepth().map(ea =>
            Object.assign(ea, {string: td.nodeToString(ea.node)})),
          lines = string.lines(
            string.printTree(td.root, td.nodeToString.bind(td), td.getChildrenIfUncollapsed.bind(td))),
          items = td.asList().map((ea, i) => ({isListItem: true, string: lines[i], value: ea})),
          {selected: [node]} = await tree.world().filterableListPrompt("Select item", items);
      if (node) {
        tree.selectedNode = node;
        tree.scrollSelectionIntoView();
      }
      return true;
    }
  },

  {
    name: "page up",
    exec: tree => {
      tree.scrollPageUp(1);
      var {scroll} = tree,
          y = tree.padding.top(),
          targetY = scroll.y,
          newIndex = tree.lineHeightCache.findIndex(h => targetY <= (y += h));
      newIndex--; // ignore root
      tree.gotoIndex(Math.max(1, newIndex));
      return true;
    }
  },

  {
    name: "page down",
    exec: tree => {
      tree.scrollPageDown(1);
      var {scroll} = tree,
          y = tree.padding.top(),
          targetY = scroll.y + tree.height,
          newIndex = tree.lineHeightCache.findIndex(h => targetY <= (y += h));
      newIndex--; // ignore root
      tree.gotoIndex(Math.min(newIndex, tree.nodes.length-1));
      return true;
    }
  },

  {
    name: "goto first item",
    exec: tree => { tree.gotoIndex(1); return true; }
  },

  {
    name: "goto last item",
    exec: tree => { tree.gotoIndex(tree.nodes.length-1); return true; }
  },

  {
    name: "goto next sibling",
    exec: tree => {
      var withSiblings = tree.selectedNodeAndSiblings,
          next = withSiblings[withSiblings.indexOf(tree.selectedNode)+1];
      if (next) {
        tree.selectedNode = next;
        tree.scrollSelectionIntoView();
      }
      return true;
    }
  },

  {
    name: "goto prev sibling",
    exec: tree => {
      var withSiblings = tree.selectedNodeAndSiblings,
          next = withSiblings[withSiblings.indexOf(tree.selectedNode)-1];
      if (next) {
        tree.selectedNode = next;
        tree.scrollSelectionIntoView();
      }
      return true;
    }
  },

  {
    name: "goto parent",
    exec: tree => {
      if (tree.selectedNode) {
        tree.selectedNode = tree.treeData.parentNode(tree.selectedNode);
        tree.scrollSelectionIntoView();
      }
      return true;
    }
  },

  {
    name: "collapse selected node",
    exec: async tree => {
      var sel = tree.selectedNode;
      if (!sel) return true;
      if (!tree.treeData.isCollapsed(sel))
        await tree.onNodeCollapseChanged({node: tree.selectedNode, isCollapsed: true});
      else {
        tree.selectedNode = tree.treeData.parentNode(sel);
        tree.scrollSelectionIntoView();
      }
      return true;
    }
  },

  {
    name: "uncollapse selected node",
    exec: async tree => {
      if (tree.selectedNode)
        await tree.onNodeCollapseChanged({node: tree.selectedNode, isCollapsed: false});
      return true;
    }
  },

  {
    name: "collapse or uncollapse all siblings",
    exec: async (treeMorph, opts = {what: "collapse"}) => {

      var doCollapse = opts.what === "collapse";
      var td = treeMorph.treeData;
      var nodesToChange;

      if (doCollapse) {
        // find all the parent nodes of the nodes deepest in the tree below the
        // selected node and collapse those
        if (td.isCollapsed(treeMorph.selectedNode)) return true;

        var startNode = td.parentNode(treeMorph.selectedNode);
        var maxDepth = -1;
        tree.prewalk(startNode,
          (node, i, depth) => {
            if (depth < maxDepth) return;
            if (depth > maxDepth) {
              maxDepth = depth;
              nodesToChange = [];
            }
            if (depth === maxDepth)
              arr.pushIfNotIncluded(nodesToChange, td.parentNode(node));
          },
          td.getChildrenIfUncollapsed.bind(td));

      } else {
        // find the non-leaf nodes below the selection that are at the same
        // depth and at least one of those non-leaf nodes is collapsed:
        // uncollapse all collapsed of this set
        var parents = arr.compact([td.parentNode(treeMorph.selectedNode)]);
        while (true) {
          if (!parents.length) break;
          nodesToChange = arr.flatmap(parents, n => allNonLeafChildren(n));
          var needCollapseChange = nodesToChange.every(n => td.isCollapsed(n) === doCollapse);
          if (!needCollapseChange) break;
          parents = nodesToChange;
        }
      }

      await collapseOrUncollapse(nodesToChange, doCollapse);

      treeMorph.scrollSelectionIntoView();

      return true;

      function allNonLeafChildren(parent) {
        return td.getChildrenIfUncollapsed(parent).filter(n => !td.isLeaf(n));
      }

      function collapseOrUncollapse(nodes, doCollapse) {
        return Promise.all(nodes.map(node => treeMorph.onNodeCollapseChanged({node, isCollapsed: doCollapse})));
      }

    }
  },

  {
    name: "select node above",
    exec: treeMorph => {
      var nodes = treeMorph.nodes,
          index = treeMorph.selectedIndex;
      if (index <= 1) index = nodes.length;
      treeMorph.selectedNode = nodes[index-1];
      treeMorph.scrollSelectionIntoView();
      return true;
    }
  },

  {
    name: "select node below",
    exec: tree => {
      var nodes = tree.nodes,
          index = tree.selectedIndex;
      if (index <= -1 ||  index >= nodes.length-1) index = 0;
      tree.selectedNode = nodes[index+1];
      tree.scrollSelectionIntoView();
      return true;
    }
  },

  {
    name: "realign top-bottom-center",
    exec: tree => {
      if (!tree.selectedNode) return;
      var {padding, selectedIndex: idx, scroll: {x: scrollX, y: scrollY}} = tree,
          lineBounds = tree.lineBounds(idx),
          pos = lineBounds.topLeft(),
          offsetX = 0, offsetY = 0,
          h = tree.height - lineBounds.height;
      if (Math.abs(pos.y - scrollY) < 2) {
        scrollY = pos.y - h;
      } else if (Math.abs(pos.y - scrollY - h * 0.5) < 2) {
        scrollY = pos.y;
      } else {
        scrollY = pos.y - h * 0.5;
      }
      tree.scroll = pt(scrollX, scrollY);
      return true;
    }
  },

  {
    name: "print contents in text window",
    exec: treeMorph => {
      var td = treeMorph.treeData,
          content = string.printTree(td.root, td.nodeToString.bind(td), td.getChildrenIfUncollapsed.bind(td)),
          title = treeMorph.getWindow() ?
            "printed " + treeMorph.getWindow().title :
            treeMorph.name;

      return treeMorph.world().execCommand("open text window", {
        title, content, name: title,
        fontFamily: config.codeEditor.defaultStyle.fontFamily
      });
    }
  }

];
