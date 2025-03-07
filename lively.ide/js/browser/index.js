import { Color, rect, pt, Rectangle } from "lively.graphics";
import { arr, Path, obj, fun, promise, string } from "lively.lang";
import { connect } from "lively.bindings";
import {
  morph, easings,
  StyleSheet,
  HorizontalLayout, 
  GridLayout,
  config,
  Icon
} from "lively.morphic";
import Window from "lively.components/window.js";
import { HorizontalResizer } from "lively.components/resizers.js";
import { Tree, TreeData } from "lively.components/tree.js";

import JSONEditorPlugin from "lively.ide/json/editor-plugin.js";
import JavaScriptEditorPlugin from "../editor-plugin.js";
import EvalBackendChooser from "../eval-backend-ui.js";
import browserCommands from "./commands.js";

import "mocha-es6/index.js";


// -=-=-=-=-=-
// Browser UI
// -=-=-=-=-=-

import { findDecls } from "lively.ast/lib/code-categorizer.js";
import { testsFromSource } from "../../test-runner.js";
import { module } from "lively.modules/index.js";
import DarkTheme from "../../themes/dark.js";
import DefaultTheme from "../../themes/default.js";

class CodeDefTreeData extends TreeData {

  constructor(defs) {
    // defs come from lively.ast.categorizer.findDecls()
    defs.forEach(ea => ea.children && (ea.isCollapsed = true));
    super({
      name: "root",
      isCollapsed: false,
      children: defs.filter(ea => !ea.parent)
    });
    this.defs = defs;
  }

  display(node) {
    var string = String(node.name);
    if (node.type === "class-instance-getter") string = "get " + string;
    if (node.type === "class-instance-setter") string = "set " + string;
    return string;
  }
  isLeaf(node) { return !node.children; }
  isCollapsed(node) { return node.isCollapsed; }
  collapse(node, bool) { node.isCollapsed = bool; }
  getChildren(node) {
    return this.isLeaf(node) ?
      null : this.isCollapsed(node) ?
        [] : node.children;
  }
}

// Browser.browse({moduleName: "lively.morphic/morph.js", codeEntity: {name: "Morph"}});
export default class Browser extends Window {

  static async browse(browseSpec = {}, browserOrProps = {}, optSystemInterface) {
    // browse spec:
    // packageName, moduleName, codeEntity, scroll, textPosition like {row: 0, column: 0}
    var browser = browserOrProps instanceof Browser ?
      browserOrProps : new this(browserOrProps);
    if (!browser.world()) browser.openInWorldNearHand();
    return browser.browse(browseSpec, optSystemInterface);
  }

  static get properties() {

    return {
      name: {defaultValue: "browser"},
      extent: {defaultValue: pt(700,600)},
      styleSheets: {
        initialize() {
          this.styleSheets = new StyleSheet({
            "[name=moduleList]": {
              borderColor: Color.gray,
              borderWidthRight: 1,
            },
            ".node [name=metaInfoText]": {
              fill: Color.rgb(86, 101, 115),
              fontColor: Color.rgb(214, 219, 223)
            },
            ".local [name=metaInfoText]": {
              fill: Color.white,
              fontColor: Color.black
            },
            ".Button.default [name=label]": {
              fontSize: 10,
              padding: rect(1,1,1,1)
            },
            ".Button.default": {
              padding: rect(5,3,0,0)
            },
            ".Button.dark [name=label]": {
              fontColor: Color.white,
              fontSize: 10
            },
            ".Button.triggerStyle.default": {
              fill: Color.gray,
            },
            ".Button.dark": {
              fontColor: Color.white,
              fill: Color.black.withA(0.5),
              borderWidth: 0,
              borderRadius: 5,
              nativeCursor: "pointer",
              extent: pt(20, 18)
            }
          });
        }
      },
      systemInterface: {
        derived: true,
        readOnly: true,
        after: ["editorPlugin"],
        get() {
          return this.editorPlugin.systemInterface();
        },
        set(systemInterface) {
          this.editorPlugin.setSystemInterfaceNamed(systemInterface);
        }
      },

      editorPlugin: {
        after: ["submorphs"],
        readOnly: true,
        derived: true,
        get() {
          return this.get("sourceEditor").pluginFind(p => p.isEditorPlugin);
        }
      }
    };
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // initialization
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  reset() {
    if (!this.targetMorph) this.targetMorph = this.build();

    this._inLayout = true;

    connect(this, "extent", this, "relayout");

    var {
      moduleList, sourceEditor,
      searchButton,
      addModuleButton,
      addPackageButton,
      browseHistoryButton,
      browseModulesButton,
      historyBackwardButton,
      historyForwardButton,
      removeModuleButton,
      removePackageButton,
      runTestsInModuleButton,
      runTestsInPackageButton,
      codeEntityJumpButton,
      codeEntityTree
    } = this.ui;

    connect(searchButton,          "fire", this, "execCommand", {converter: () => "open code search"});
    connect(historyBackwardButton, "fire", this, "execCommand", {converter: () => "browser history backward"});
    connect(historyForwardButton,  "fire", this, "execCommand", {converter: () => "browser history forward"});
    connect(browseHistoryButton,   "fire", this, "execCommand", {converter: () => "browser history browse"});
    connect(browseModulesButton,   "fire", this, "execCommand", {converter: () => "choose and browse module"});
    connect(addPackageButton,      "fire", this, "execCommand", {converter: () => "add package"});
    connect(removePackageButton,   "fire", this, "execCommand", {converter: () => "remove package"});
    connect(addModuleButton,       "fire", this, "execCommand", {converter: () => "load or add module"});
    connect(removeModuleButton,    "fire", this, "execCommand", {converter: () => "remove module"});
    connect(runTestsInModuleButton,"fire", this, "execCommand", {converter: () => "run all tests in module"});
    connect(runTestsInPackageButton,"fire", this, "execCommand", {converter: () => "run all tests in package"});
    connect(codeEntityJumpButton,   "fire", this, "execCommand", {converter: () => "jump to codeentity"});

    connect(moduleList, "selection", this, "onModuleSelected");
    connect(codeEntityTree, "selectedNode", this, "onCodeEntitySelected");

    connect(sourceEditor, "textChange", this, "updateUnsavedChangeIndicatorDebounced");
    connect(sourceEditor, 'onMouseDown', this, 'updateFocusedCodeEntity');

    moduleList.selection = null;
    moduleList.items = [];
    sourceEditor.textString = "";

    this._inLayout = false;
  }

  __additionally_serialize__(snapshot, objRef, pool, addFn) {
    super.__additionally_serialize__(snapshot, objRef, pool, addFn);

    // remove unncessary stuff
    // FIXME offer option in object ref or pool or removeFn to automate this stuff!
    var ref = pool.ref(this.ui.moduleList);
    if (ref.currentSnapshot.props.items)
      ref.currentSnapshot.props.items.value = [];
    if (ref.currentSnapshot.props.selection)
      ref.currentSnapshot.props.selection.value = null;

    var ref = pool.ref(this.ui.codeEntityTree);
    if (ref.currentSnapshot.props.selection)
      ref.currentSnapshot.props.selection.value = null;

    var ref = pool.ref(this.ui.codeEntityTree.nodeItemContainer);
    if (ref.currentSnapshot.props.submorphs)
      ref.currentSnapshot.props.submorphs.value = [];

    var ref = pool.ref(this.ui.codeEntityTree.treeData);
    ref.currentSnapshot.props.defs.value = [];
    ref.currentSnapshot.props.root.value = {};
    ref.currentSnapshot.props.root.verbatim = true;

    var ref = pool.ref(this.ui.sourceEditor),
        props = ref.currentSnapshot.props;
    if (props.textAndAttributes) props.textAndAttributes.value = [];
    if (props.attributeConnections) props.attributeConnections.value = [];
    if (props.plugins) props.plugins.value = [];
    if (props.anchors) props.anchors.value =
      props.anchors.value.filter(({id}) => id.startsWith("selection-"));
    if (props.savedMarks) props.savedMarks.value = [];

    // remember browse state
    var {
      ui: {sourceEditor, codeEntityTree, codeEntityTree, moduleList},
      selectedPackage,
      selectedModule,
      selectedCodeEntity
    } = this;

    snapshot.props._serializedState = {
      verbatim: true,
      value: {
        packageName: selectedPackage ? selectedPackage.name : null,
        moduleName: selectedModule ? selectedModule.nameInPackage : null,
        codeEntity: selectedCodeEntity ? selectedCodeEntity.name : null,
        textPosition: sourceEditor.textPosition,
        scroll: sourceEditor.scroll,
        codeEntityTreeScroll: codeEntityTree.scroll,
        moduleListScroll: moduleList.scroll,
      }
    };
  }

  async onLoad() {
    this.state = {
      packageUpdateInProgress: null,
      moduleUpdateInProgress: null,
      selectedPackage: null,
      sourceHash: null,
      moduleChangeWarning: null,
      isSaving: false,
      history: {left: [], right: [], navigationInProgress: null}
    };
    this.reset();
    this.relayout();
    var ed = this.ui.sourceEditor;
    if (!ed.plugins.length)
      ed.addPlugin(new JavaScriptEditorPlugin(config.codeEditor.defaultTheme));

    if (this._serializedState) {
      var s = this._serializedState;
      delete this._serializedState;
      await this.browse(s);
    }
  }

  build() {
    // this.relayout();
    // this.removeAllMorphs(); this.targetMorph = this.build();

    this._inLayout = true;

    this.targetMorph && this.targetMorph.remove();

    let style = {
          // borderWidth: 1, borderColor: Color.gray,
          draggable: false,
          fontSize: 14, fontFamily: "Helvetica Neue, Arial, sans-serif"
        },
        textStyle = {
          borderWidth: 1, borderColor: Color.gray,
          lineWrapping: "by-chars",
          type: "text",
          ...config.codeEditor.defaultStyle
        },

        btnStyle = {
          type: "button",
          styleClasses: ["default"]
        },

        btnDarkStyle = {
          type: "button",
          styleClasses: ["dark"],
        },

        bounds = this.targetMorphBounds(),

        [
          browserCommandsBounds,
          moduleListBounds,
          codeEntityTreeBounds,
          moduleCommandBoxBounds,
          codeEntityCommandBoxBounds,
          resizerBounds,
          metaInfoBounds,
          sourceEditorBounds
        ] = bounds.extent().extentAsRectangle().divide([
          new Rectangle(0,   0,    1,   0.04),
          new Rectangle(0,   0.04, 0.5, 0.34),
          new Rectangle(0.5, 0.04, 0.5, 0.34),
          new Rectangle(0,   0.34, 0.5, 0.04),
          new Rectangle(0.5, 0.34, 0.5, 0.04),
          new Rectangle(0,   0.38,  1,   0.01),
          new Rectangle(0,   0.39,  1,   0.03),
          new Rectangle(0,   0.42, 1,   0.57)]),

        container = morph({
          ...style,
          fill: Color.transparent,
          reactsToPointer: false,
          bounds,
          submorphs: [

            {name: "moduleList", bounds: moduleListBounds, type: "list", ...style },

            new Tree({name: "codeEntityTree", treeData: new CodeDefTreeData([]),
              bounds: codeEntityTreeBounds, ...style}),

            {name: "moduleCommands", bounds: moduleCommandBoxBounds,
              layout: new HorizontalLayout({spacing: 2, autoResize: false, direction: "rightToLeft"}),
              borderRight: {color: Color.gray, width: 1},
              reactsToPointer: false,
              fill: Color.transparent,
              submorphs: [
                {...btnDarkStyle, name: "addModuleButton", label: Icon.makeLabel("plus"), tooltip: "add module"},
                {...btnDarkStyle, name: "removeModuleButton", label: Icon.makeLabel("minus"), tooltip: "remove package"},
                {...btnDarkStyle, name: "runTestsInModuleButton", label: "run tests", tooltip: "run tests", visible: false}
              ]},

            {name: "codeEntityCommands", bounds: codeEntityCommandBoxBounds,
              layout: new HorizontalLayout({spacing: 2, autoResize: false, direction: "rightToLeft"}),
              fill: Color.transparent,
              submorphs: [
                {...btnDarkStyle, name: "codeEntityJumpButton", label: Icon.makeLabel("search"), tooltip: "search for code entity"},
              ]},

            new HorizontalResizer({name: "hresizer", bounds: resizerBounds}),

            {
              name: "metaInfoText",
              bounds: metaInfoBounds,
              ...textStyle,
              type: 'label',
              autofit: false,
              fill: Color.white,
              fontSize: config.codeEditor.defaultStyle.fontSize - 2,
              clipMode: "hidden",
              borderWidth: 1
            },
            {name: "sourceEditor", bounds: sourceEditorBounds, 
             borderRadius: Rectangle.inset(7,0,7,7),
             borderWidthLeft: 3,
             ...textStyle},

            {name: "browserCommands", bounds: browserCommandsBounds,
              layout: new GridLayout({
                grid: [["commands", null, "eval backend button", null]],
                rows: [0, {paddingBottom: 2}],
                columns: [0, {paddingLeft: 2}, 2, {fixed: 100}, 3, {fixed: 5}],
                groups: {commands: {resize: false}}
              }),
              fill: Color.transparent,
              reactsToPointer: false,
              borderBottom: {color: Color.gray, width: 1},
              submorphs: [
                {name: "commands", layout: new HorizontalLayout({
                  spacing: 2, autoResize: false, layoutOrder: function(m) {
                    return this.container.submorphs.indexOf(m);
                  }}),
                fill: Color.transparent,
                submorphs: [
                  {...btnStyle, name: "historyBackwardButton", label: Icon.makeLabel("step-backward"), tooltip: "back in browse history"},
                  {...btnStyle, name: "browseHistoryButton", label: Icon.makeLabel("history"), tooltip: "show browse history"},
                  {...btnStyle, name: "historyForwardButton", label: Icon.makeLabel("step-forward"), tooltip: "forward in browse history"},

                  {extent: pt(10,18), fill: Color.transparent},

                  {...btnStyle, name: "searchButton", label: Icon.makeLabel("search"), tooltip: "code search"},
                  {...btnStyle, name: "browseModulesButton", label: Icon.makeLabel("navicon"), tooltip: "list all modules"},

                  {extent: pt(10,18), fill: Color.transparent},

                  {...btnStyle, name: "addPackageButton", label: Icon.makeLabel("plus"), tooltip: "add package"},
                  {...btnStyle, name: "removePackageButton", label: Icon.makeLabel("minus"), tooltip: "remove package"},
                  {...btnStyle, name: "runTestsInPackageButton", label: "run tests", tooltip: "run tests", styleClasses: [], fontSize: 10, padding: rect(5,3,0,0)}

                ]},
                EvalBackendChooser.default.ensureEvalBackendDropdown(this, "local")]}
          ]
        });


    let browserCommands =    container.getSubmorphNamed("browserCommands"),
        hresizer =           container.getSubmorphNamed("hresizer"),
        moduleList =         container.getSubmorphNamed("moduleList"),
        moduleCommands =     container.getSubmorphNamed("moduleCommands"),
        codeEntityCommands = container.getSubmorphNamed("codeEntityCommands"),
        codeEntityTree =     container.getSubmorphNamed("codeEntityTree"),
        sourceEditor =       container.getSubmorphNamed("sourceEditor"),
        metaInfoText =       container.getSubmorphNamed("metaInfoText");

    browserCommands.withAllSubmorphsDo(b => b.isButton && b.fit());

    hresizer.addScalingAbove(moduleList);
    hresizer.addScalingAbove(codeEntityTree);
    hresizer.addFixed(moduleCommands);
    hresizer.addFixed(codeEntityCommands);
    hresizer.addFixed(metaInfoText);
    hresizer.addScalingBelow(sourceEditor);

    this._inLayout = false;

    return container;
  }


  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // layouting
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  relayout() {
    if (this.minimized) return;
    if (this._inLayout) return;

    this._inLayout = true;

    var {
      container,
      moduleList,
      codeEntityTree,
      browserCommands,
      moduleCommands,
      codeEntityCommands,
      metaInfoText,
      sourceEditor,
      hresizer,
      evalBackendList
    } = this.ui;

    var listEditorRatio = moduleList.height / (container.height - hresizer.height);

    try {
      container.setBounds(this.targetMorphBounds());

      [moduleList, moduleCommands, codeEntityTree, codeEntityCommands]
        .forEach(ea => ea.width = container.width/2);
      [moduleCommands, codeEntityCommands]
        .forEach(ea => ea.height = hresizer.top-moduleList.bottom);

      codeEntityCommands.left = codeEntityTree.left = moduleList.right;
      if (evalBackendList)
        browserCommands.layout.col(2).width = evalBackendList.width;
      browserCommands.width = hresizer.width = container.width;
      metaInfoText.top = hresizer.bottom + 1;
      metaInfoText.width = browserCommands.width + 1;
      sourceEditor.setBounds(
        new Rectangle(
          0, metaInfoText.bottom,
          metaInfoText.width - sourceEditor.borderWidth + 1,
          container.height - metaInfoText.bottom));
    } finally { this._inLayout = false; }
  }


  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // accessing
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  get isBrowser() { return true; }

  get ui() {
    return this._ui || (this._ui = {
      container:             this.targetMorph,
      addModuleButton:       this.getSubmorphNamed("addModuleButton"),
      addPackageButton:      this.getSubmorphNamed("addPackageButton"),
      browseHistoryButton:   this.getSubmorphNamed("browseHistoryButton"),
      browseModulesButton:   this.getSubmorphNamed("browseModulesButton"),
      browserCommands:       this.getSubmorphNamed("browserCommands"),
      codeEntityTree:        this.getSubmorphNamed("codeEntityTree"),
      historyBackwardButton: this.getSubmorphNamed("historyBackwardButton"),
      historyForwardButton:  this.getSubmorphNamed("historyForwardButton"),
      hresizer:              this.getSubmorphNamed("hresizer"),
      moduleCommands:        this.getSubmorphNamed("moduleCommands"),
      codeEntityCommands:    this.getSubmorphNamed("codeEntityCommands"),
      moduleList:            this.getSubmorphNamed("moduleList"),
      removeModuleButton:    this.getSubmorphNamed("removeModuleButton"),
      removePackageButton:   this.getSubmorphNamed("removePackageButton"),
      runTestsInPackageButton:this.getSubmorphNamed("runTestsInPackageButton"),
      runTestsInModuleButton:this.getSubmorphNamed("runTestsInModuleButton"),
      codeEntityJumpButton:  this.getSubmorphNamed("codeEntityJumpButton"),
      searchButton:          this.getSubmorphNamed("searchButton"),
      metaInfoText:          this.getSubmorphNamed("metaInfoText"),
      sourceEditor:          this.getSubmorphNamed("sourceEditor"),
      evalBackendList:       this.getSubmorphNamed("eval backend button")
    });
  }

  get selectedModule() { return this.ui.moduleList.selection; }
  set selectedModule(m) {
    var mlist = this.ui.moduleList;
    if (!m) mlist.selection = null;
    else this.selectModuleNamed(typeof m === "string" ? m : m.name || m.id);
  }

  get selectedPackage() { return this.state.selectedPackage; }
  set selectedPackage(p) {
    this.selectPackageNamed(!p ? null : typeof p === "string" ? p : p.url || p.address);
  }

  get selectedCodeEntity() { return this.ui.codeEntityTree.selectedNode; }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // source changes
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  updateSource(source, cursorPos) {
    var ed = this.ui.sourceEditor;
    if (ed.textString != source) ed.textString = source;
    this.state.sourceHash = string.hashCode(source);
    this.indicateNoUnsavedChanges();
    this.state.moduleChangeWarning = null;
    if (cursorPos) ed.cursorPosition = cursorPos;
  }

  indicateUnsavedChanges() {
    Object.assign(this.ui.sourceEditor,
      {border: {width: 2, color: Color.red}});
  }

  indicateNoUnsavedChanges() {
    Object.assign(this.ui.sourceEditor,
      {border: {width: 2, color: Color.transparent}});
  }

  hasUnsavedChanges() {
    return this.state.sourceHash !== string.hashCode(this.ui.sourceEditor.textString);
  }

  updateUnsavedChangeIndicatorDebounced() {
    fun.debounceNamed(this.id + "-updateUnsavedChangeIndicatorDebounced", 20,
      () => this.updateUnsavedChangeIndicator())();
  }

  updateUnsavedChangeIndicator() {
    this[this.hasUnsavedChanges() ? "indicateUnsavedChanges" : "indicateNoUnsavedChanges"]();
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // system interface
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  async setEvalBackend(newRemote) {
    newRemote = newRemote || "local";
    let {selectedPackage, selectedModule, systemInterface: oldSystemInterface} = this,
        p = selectedPackage && selectedPackage.name,
        mod = selectedModule && selectedModule.nameInPackage;
    if (newRemote !== oldSystemInterface.name) {
      this.editorPlugin.setSystemInterfaceNamed(newRemote);
      await this.toggleWindowStyle();
      this.reset();
      let {systemInterface: newSystemInterface} = this;
      let packages = await newSystemInterface.getPackages(),
          pSpec = p && packages.find(ea => ea.name === p);
      if (pSpec) {
        await this.selectPackageNamed(p);
        let modFound = pSpec.modules.find(
          ea => newSystemInterface.shortModuleName(ea.name, pSpec) === mod);
        await this.selectModuleNamed(modFound ? mod : pSpec.main);
      } else {
        await this.selectPackageNamed(packages[0].name);
        await this.selectModuleNamed(packages[0].main);
      }
      this.relayout();
    }
  }

  async toggleWindowStyle(animated = true) {
    let duration = 1000, easing = easings.outExpo,
        theme, styleClasses;
    if ((await this.editorPlugin.runEval("System.get('@system-env').node")).value) {
      styleClasses = [...arr.without(this.styleClasses, 'local'), 'node'];
      theme = DarkTheme.instance;
    } else {
      styleClasses = ['local', ...arr.without(this.styleClasses, 'node')];
      theme = DefaultTheme.instance;
    }
    this.editorPlugin.theme = theme;
    if (animated) {
      this.animate({ duration, styleClasses, easing });
      this.ui.sourceEditor.animate({
        fill: theme.background, duration, easing
      });
    } else {
      this.styleClasses = styleClasses;
    }
    this.editorPlugin.highlight();
    this.relayout();
  }

  async packageResources(p) {
    let excluded = (Path("lively.ide.exclude").get(p) || []).map(ea =>
      ea.includes("*") ? new RegExp(ea.replace(/\*/g, ".*")): ea);
    excluded.push(".git", "node_modules", ".module_cache");
    try {
      return (await this.systemInterface.resourcesOfPackage(p.address, excluded))
        .filter(({url}) => (url.endsWith(".js") || url.endsWith(".json"))
                        && !excluded.some(ex => ex instanceof RegExp ? ex.test(url): url.includes(ex)))
        .map((ea) => { ea.name = ea.url; return ea; });
    } catch (e) { this.showError(e); return []; }
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // browser actions
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  async browse(browseSpec = {}, optSystemInterface) {
    // browse spec:
    // packageName, moduleName, codeEntity, scroll, textPosition like {row: 0, column: 0}

    let {
          packageName,
          moduleName,
          textPosition,
          codeEntity,
          scroll,
          codeEntityTreeScroll,
          moduleListScroll,
          systemInterface
        } = browseSpec,
        {sourceEditor, codeEntityTree, moduleList} = this.ui;

    if (optSystemInterface || systemInterface) {
      this.systemInterface = optSystemInterface || systemInterface;
      if (this.ui.evalBackendList)
        await this.ui.evalBackendList.updateFromTarget();
    }

    await this.toggleWindowStyle(false);

    if (packageName) {
      await this.selectPackageNamed(packageName);
      if (moduleName) await this.selectModuleNamed(moduleName);

    } else if (moduleName) {
      let system = this.systemInterface,
          m = await system.getModule(moduleName), p;

      if (m) {
        moduleName = m.id;
        p = await system.getPackageForModule(m.id);
      } else {
        let mNameParts = moduleName.split("/"),
            pName = mNameParts.shift(),
            mNameRest = mNameParts.join("/");
        p = await system.getPackage(pName);
        m = await system.getModule(`${p.url}/${mNameRest}`);
      }

      if (m && p) {
        moduleName = m.id;
        let p = await system.getPackageForModule(m.id);
        await this.selectPackageNamed(p.url);
        await this.selectModuleNamed(moduleName);
      }
    }

    if (codeEntity) {
      await this.selectCodeEntity(codeEntity);
    }

    if (textPosition) {
      if (this.world()) await promise.delay(10);
      sourceEditor.cursorPosition = textPosition;
      sourceEditor.centerRow(textPosition.row);
    }

    if (scroll) {
      if (this.world()) await promise.delay(10);
      sourceEditor.scroll = scroll;
    }

    if (moduleListScroll) moduleList.scroll = moduleListScroll;
    if (codeEntityTreeScroll) codeEntityTree.scroll = codeEntityTreeScroll;

    return this;
  }

  whenPackageUpdated() { return this.state.packageUpdateInProgress || Promise.resolve(); }
  whenModuleUpdated() { return this.state.moduleUpdateInProgress || Promise.resolve(); }

  async selectPackageNamed(pName) {
    let p = pName ? await this.systemInterface.getPackage(pName) : null;
    this.onPackageSelected(p);
    await this.whenPackageUpdated();
    return p;
  }

  async onPackageSelected(p) {
    this.state.selectedPackage = p;
    if (!this.state.packageUpdateInProgress) {
      var deferred = promise.deferred();
      this.state.packageUpdateInProgress = deferred.promise;
    }

    try {
      let {metaInfoText, moduleList} = this.ui;
      metaInfoText.textString = "";
      if (!p) {
        moduleList.items = [];
        this.updateSource("");
        this.title = "browser";
      } else {
        this.title = "browser - " + p.name;
        moduleList.selection = null;
        await this.updateModuleList(p);
      }

    } finally {
      if (deferred) {
        this.state.packageUpdateInProgress = null;
        deferred.resolve(p);
      }
    }
  }

  async selectModuleNamed(mName) {
    let list = this.ui.moduleList,
        m = list.selection = list.values.find(({nameInPackage, name}) =>
          mName === name || mName === nameInPackage);

    if (!m) {
      let system = this.systemInterface,
          p = this.state.selectedPackage,
          url, nameInPackage;

      if (await system.doesModuleExist(mName)) {
        if (p && !mName.startsWith(p.url)) {
          nameInPackage = mName;
          url = p.url + "/" + mName;
        } else url = nameInPackage = mName;

      } else if (p && await system.doesModuleExist(p.url + "/" + mName, true)) {
        url = p.url + "/" + mName;
        nameInPackage = mName;
      }

      if (url) {
        let isLoaded = await system.isModuleLoaded(url, true),
            item = {
              isListItem: true,
              string: nameInPackage,
              value: {
                isLoaded, name: url, nameInPackage, url,
                package: p ? p.url : null,
              }
            };
        list.addItem(item);
        m = list.selection = item.value;
      }
    }

    await this.whenModuleUpdated();
    return m;
  }

  async searchForModuleAndSelect(moduleURI) {
    // moduleURI = System.decanonicalize("lively.vm")
    // var x= await (that.getWindow().searchForModuleAndSelect(System.decanonicalize("lively.vm")));

    var {selectedModule, selectedPackage} = this;
    if (selectedModule && selectedModule.name === moduleURI)
      return selectedModule;

    var system = this.systemInterface,
        mods = await system.getModules(),
        m = mods.find(({name}) => name === moduleURI),
        p = m && await system.getPackageForModule(m.name);

    if (!p) return null;
    await this.selectPackageNamed(p.address);
    await this.selectModuleNamed(m.name);
    return this.selectedModule;
  }

  async onModuleSelected(m) {
    let pack = this.state.selectedPackage;

    if (this._return) return;
    if (this.selectedModule && this.hasUnsavedChanges()) {
      let proceed = await this.world().confirm([
      'Discard Changes\n', {}, 'The unsaved changes to this module are going to be discarded.\nAre you sure you want to proceed?', {fontSize: 16, fontWeight: 'normal'}], { requester: this });
      if (!proceed) {
        this._return = true;
        let m = await this.state.history.navigationInProgress;
        await this.selectModuleNamed(arr.last(this.state.history.left).module.name)
        this._return = false;
        return;
      }
    }
    
    this.state.moduleChangeWarning = null;

    if (!m) {
      this.updateSource("");
      this.title = "browser - " + (pack && pack.name || "");
      this.updateCodeEntities(null);
      this.ui.metaInfoText.textString = "";
      return;
    }

    if (!pack) {
      this.showError(new Error("Browser>>onModuleSelected called but no package selected!" + m));
      return;
    }

    if (!this.state.moduleUpdateInProgress) {
      var deferred = promise.deferred();
      this.state.moduleUpdateInProgress = deferred.promise;
    }

    try {
      var system = this.systemInterface;

      if (!m.isLoaded && m.name.endsWith(".js")) {
        var err;
        try { await system.importModule(m.name); }
        catch(e) { err = e; }

        if (err) this.showError(err);

        var p = await system.getPackage(pack.address),
            isLoadedNow = p.modules.map(ea => ea.name).includes(m.name);

        if (isLoadedNow) {
          Object.assign(pack, p);
          m.isLoaded = true;
          // await this.selectPackageNamed(pack.address);
          await this.updateModuleList();
          this.state.moduleUpdateInProgress = null;
          await this.selectModuleNamed(m.name);
          m = this.selectedModule;
          if (deferred)
            this.state.moduleUpdateInProgress = deferred.promise;
          return;
        }
      }

      this.ui.moduleList.scrollSelectionIntoView();
      this.title = `browser - [${pack.name}] ${m.nameInPackage}`;
      var source = await system.moduleRead(m.name);
      this.updateSource(source, {row: 0, column: 0});

      await this.prepareCodeEditorForModule(m);

      this.historyRecord();

      await this.updateCodeEntities(m);
      await this.updateTestUI(m);

      this.ui.metaInfoText.textAndAttributes = [
        `[${pack.name}]`,
        {
          nativeCursor: "pointer",
          textDecoration: "underline",
          doit: {code: `$world.execCommand("open file browser", {location: "${pack.url}"})`}
        },
        " ", null,
        m.nameInPackage, {},
        ` (${await system.moduleFormat(m.url)} format)`, {},
        " - ", null
      ];

    } finally {
      if (deferred) {
        this.state.moduleUpdateInProgress = null;
        deferred.resolve(m);
      }
    }
  }

  async prepareCodeEditorForModule(module) {
    var system = this.systemInterface,
        format = (await system.moduleFormat(module.name)) || "esm",
        [_, ext] = module.name.match(/\.([^\.]+)$/) || [];
    // FIXME we already have such "mode" switching code in the text editor...
    // combine these?!
    var Mode = JavaScriptEditorPlugin;
    switch (ext) {
    case "js": /*default*/break;
    case "json": Mode = JSONEditorPlugin; break;
    }

    // switch text mode
    if (this.editorPlugin.constructor !== Mode) {
      var env = this.editorPlugin.evalEnvironment;
      this.ui.sourceEditor.removePlugin(this.editorPlugin);
      this.ui.sourceEditor.addPlugin(new Mode(config.codeEditor.defaultTheme));
      Object.assign(this.editorPlugin.evalEnvironment, env);
      this.editorPlugin.highlight();
    }

    Object.assign(this.editorPlugin.evalEnvironment, {
      targetModule: module.name,
      context: this.ui.sourceEditor,
      format
    });

  }

  updateFocusedCodeEntity() {
     let { sourceEditor, metaInfoText, codeEntityTree } = this.ui,
          cursorIdx = sourceEditor.positionToIndex(sourceEditor.cursorPosition),
          {parent, name} = arr.last(codeEntityTree.treeData.defs.filter(
            ({node: {start, end}}) => start < cursorIdx && cursorIdx < end)) || {}
    if (name) {
      metaInfoText.textAndAttributes = [
        ...metaInfoText.textAndAttributes.slice(0,6), 
        ` ${parent ? parent.name + ">>" : ""}${name}`];
    }
  }

  async onCodeEntitySelected(entity) {
    if (!entity) return;
    var { sourceEditor, metaInfoText } = this.ui,
        start = sourceEditor.indexToPosition(entity.node.start),
        end = sourceEditor.indexToPosition(entity.node.end);
    sourceEditor.cursorPosition = start;
    sourceEditor.flash({start, end}, {id: "codeentity", time: 1000, fill: Color.rgb(200,235,255)});
    if (this.world()) await sourceEditor.whenRendered();
    sourceEditor.centerRange({start, end});
  }

  findCodeEntity({name, type, parent}) {
    var parentDef = parent ? this.findCodeEntity(parent) : null;
    var defs = this.ui.codeEntityTree.treeData.defs;
    if (!defs) return null;
    return defs.find(def => {
      if (parentDef && def.parent !== parentDef) return false;
      if (def.name !== name) return false;
      if (!type || def.type === type) return true;
      if (type === "method" && def.type.includes("method")) return true;
      return false;
    });
  }

  async selectCodeEntity(spec) {
    if (typeof spec === "string") spec = {name: spec};
    var {codeEntityTree} = this.ui, td = codeEntityTree.treeData,
        def = this.findCodeEntity(spec),
        path = []; while (def) { path.unshift(def); def = def.parent; }
    await codeEntityTree.selectPath(path);
    codeEntityTree.centerSelection();
    return def;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-


  async updateModuleList(p = this.selectedPackage) {
    if (!p) return;
    let mods = await this.packageResources(p);

    this.ui.moduleList.items = mods.sort((a, b) => {
      if (a.isLoaded && !b.isLoaded) return -1;
      if (!a.isLoaded && b.isLoaded) return 1;
      if (a.nameInPackage.toLowerCase() < b.nameInPackage.toLowerCase()) return -1;
      if (a.nameInPackage.toLowerCase() == b.nameInPackage.toLowerCase()) return 0;
      return 1;
    })
      .map(m => ({string: m.nameInPackage + (m.isLoaded ? "" : " [not loaded]"), value: m, isListItem: true}));

    await this.ui.moduleList.whenRendered();
  }

  updateCodeEntities(mod) {
    let {editorPlugin, ui: {codeEntityTree}} = this;

    if (!mod || !editorPlugin || !editorPlugin.isJSEditorPlugin) {
      codeEntityTree.treeData = new CodeDefTreeData([]);
      return;
    }

    let parsed = editorPlugin.getNavigator().ensureAST(editorPlugin.textMorph),
        decls = findDecls(parsed);
    codeEntityTree.treeData = new CodeDefTreeData(decls);
  }

  updateTestUI(mod) {
    var { runTestsInModuleButton, sourceEditor, moduleCommands } = this.ui,
        hasTests = false;
    if (this.editorPlugin.isJSEditorPlugin) {
      try {
        var ast = this.editorPlugin.getNavigator().ensureAST(sourceEditor),
            tests = testsFromSource(ast || sourceEditor.textString);
        hasTests = tests && tests.length;
      } catch (err) {
        console.warn(`sytem browser updateTestUI: ${err}`);
        hasTests = false;
      }
    }
    runTestsInModuleButton.visible = runTestsInModuleButton.isLayoutable = !!hasTests;
  }

  async save(attempt = 0) {
    let {ui: {moduleList, sourceEditor}, state} = this,
        module = moduleList.selection;

    if (!module) return this.setStatusMessage("Cannot save, no module selected", Color.red);

    let content = this.ui.sourceEditor.textString,
        system = this.systemInterface;

    // moduleChangeWarning is set when this browser gets notified that the
    // current module was changed elsewhere (onModuleChanged) and it also has
    // unsaved changes
    if (state.sourceHash !== string.hashCode(content)
     && state.moduleChangeWarning && state.moduleChangeWarning === module.name) {
      let really = await this.world().confirm(
        `The module ${module.name} you are trying to save changed elsewhere!\nOverwrite those changes?`);
      if (!really) {
        this.setStatusMessage("Save canceled");
        return;
      }
      state.moduleChangeWarning = null;
    }

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // FIXME!!!!!! redundant with module load / prepare "mode" code!
    let format = (await system.moduleFormat(module.name)) || "esm",
        [_, ext] = module.name.match(/\.([^\.]+)$/) || [];
    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

    state.isSaving = true;
    try {
      // deal with non-js code, this needs to be cleaned up as well!
      if (ext !== "js") {
        if (module.nameInPackage === "package.json") {
          await system.packageConfChange(content, module.name);
          this.setStatusMessage("updated package config", Color.green);

        } else {
          await system.coreInterface.resourceWrite(module.name, content);
          this.setStatusMessage(`saved ${module.nameInPackage}`, Color.green);
        }

      // js save
      } else {

        if (config.systemBrowser.fixUndeclaredVarsOnSave) {
          let fixed = await sourceEditor.execCommand("[javascript] fix undeclared variables");
          if (!fixed) {
            this.setStatusMessage("Save canceled");
            return;
          }
          content = this.ui.sourceEditor.textString;
        }

        if (module.isLoaded) { // is loaded in runtime
          await system.interactivelyChangeModule(
            module.name, content, {targetModule: module.name, doEval: true});
        } else await system.coreInterface.resourceWrite(module.name, content);
      }

      this.updateSource(content);
      await this.updateCodeEntities(module);
      await this.updateTestUI(module);

    } catch(err) {

      if (attempt > 0 || err instanceof SyntaxError)
        return sourceEditor.showError(err);

      // try to reload the module, sometimes format changes (global => esm etc need a reload)
      let result = await this.reloadModule(false);
      sourceEditor.textString = content;
      return !result || result instanceof Error ?
        this.showError(err) : this.save(attempt+1);

    } finally { this.state.isSaving = false; }

    this.setStatusMessage("saved " + module.nameInPackage, Color.green);
  }

  async reloadModule(hard = false) {
    // hard reload: reset module environment and (hard) reload all module
    // dependencies.  Most of the time this is undesired as it completely
    // recreates the modules and variables (classes etc) therein, meaining that
    // existing instances might orphan
    let {selectedModule: m, systemInterface, ui: {sourceEditor}} = this,
        {scroll, cursorPosition} = sourceEditor;
    if (!m) return null;
    let reloadDeps = hard ? true : false,
        resetEnv = hard ? true : false;
    try {
      await systemInterface.interactivelyReloadModule(
        null, m.name, reloadDeps, resetEnv);
      await this.selectModuleNamed(m.nameInPackage);
      sourceEditor.scroll = scroll;
      sourceEditor.cursorPosition = cursorPosition;
    } catch(err) {
      return new Error(`Error while reloading ${m.name}:\n${err.stack || err}`);
    }
    return m;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // history
  // -=-=-=-=-

  async historyBackward() {
    if (this.state.history.left.length < 2) return;
    var current = this.state.history.left.pop(),
        before = arr.last(this.state.history.left);

    this.state.history.right.unshift(current);
    var {scroll, cursor} = this.historyGetLocation();
    current.scroll = scroll; current.cursor = cursor;

    try {
      await this.historySetLocation(before);
    } catch (e) {
      this.state.history.left.push(before);
      this.state.history.right.unshift();
      throw e;
    }
  }


  async historyForward() {
    var current = arr.last(this.state.history.left),
        next = this.state.history.right.shift();
    if (!next) return;
    this.state.history.left.push(next);

    if (current) {
      var {scroll, cursor} = this.historyGetLocation();
      current.scroll = scroll; current.cursor = cursor;
    }

    try {
      await this.historySetLocation(next);
    } catch (e) {
      this.state.history.left.pop();
      this.state.history.right.unshift(next);
      throw e;
    }
  }

  historyGetLocation() {
    var ed = this.ui.sourceEditor;
    return {
      package: this.selectedPackage,
      module: this.selectedModule,
      // codeEntity: this.get("codeStructureList").selection,
      cursor: ed.cursorPosition,
      scroll: ed.scroll
    };
  }

  historyRecord(addToRight = false) {
    if (this.state.history.navigationInProgress) return;

    this.state.history.right.length = 0;

    var loc = this.historyGetLocation(), last;
    if (addToRight) {
      while ((last = this.state.history.right[0])
          && last.module && loc.module
          && (last.module.name === loc.module.name)) {
        this.state.history.right.shift();
      }
      this.state.history.right.unshift(loc);
    } else {
      while ((last = arr.last(this.state.history.left))
          && last.module && loc.module
          && (last.module.name === loc.module.name)) {
        this.state.history.left.pop();
      }
      this.state.history.left.push(loc);
    }
  }


  historyReset() {
    this.state.history.left = [];
    this.state.history.right = [];
    this.state.history.navigationInProgress = null;
  }


  async historySetLocation(loc) {
    // var codeEntities = this.get("codeEntityTree").nodes

    if (!loc) return;

    var hstate = this.state.history;

    if (hstate.navigationInProgress) {
      await hstate.navigationInProgress;
      this.historySetLocation(loc);
      return;
    }

    var {promise: navPromise, resolve} = promise.deferred();

    hstate.navigationInProgress = navPromise;

    try {
      var ed = this.ui.sourceEditor;
      // var loc = hstate.left[0]

      await this.whenPackageUpdated();
      await this.whenModuleUpdated();
      if (!this.selectedPackage || loc.package.address !== this.selectedPackage.address)
        await this.selectPackageNamed(loc.package.address);
      if (!this.selectedModule || loc.module.name !== this.selectedModule.name)
        await this.selectModuleNamed(loc.module.name);

      ed.cursorPosition = loc.cursor;
      ed.scroll = loc.scroll;
      ed.scrollCursorIntoView();
    } finally {
      hstate.navigationInProgress = null;
      resolve();
    }
  }


  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // system events
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  async onModuleChanged(evt) {
    if (this.state.isSaving) return;

    var m = module(evt.module),
        {selectedModule, selectedPackage} = this;

    if (!selectedPackage) return;
    if (!m.package() || m.package().address !== selectedPackage.address) return;

    var mInList = this.ui.moduleList.values.find(ea => ea.url === m.id);
    if (selectedModule && selectedModule.url === m.id && mInList) {
      if (this.hasUnsavedChanges()) {
        this.addModuleChangeWarning(m.id);
        this.state.sourceHash = string.hashCode(await m.source());
      } else await this.ui.sourceEditor.saveExcursion(() => this.onModuleSelected(mInList));

    }
  }

  async onModuleLoaded(evt) {
    if (this.state.isSaving) return;

    var m = module(evt.module),
        {selectedModule, selectedPackage} = this;

    if (!selectedPackage || !m.package() || m.package().address !== selectedPackage.address)
      return;

    // add new module to list
    var mInList = this.ui.moduleList.values.find(ea => ea.url === m.id);
    if (!mInList) {
      await this.updateModuleList();
      mInList = this.ui.moduleList.values.find(ea => ea.url === m.id);
    }

    if (selectedModule && selectedModule.url === m.id && mInList) {
      if (this.hasUnsavedChanges()) {
        this.addModuleChangeWarning(m.id);
        this.state.sourceHash = string.hashCode(await m.source());
      } else await this.ui.sourceEditor.saveExcursion(() => this.onModuleSelected(mInList));
    }
  }

  addModuleChangeWarning(mid) {
    this.state.moduleChangeWarning = mid;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // events
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  setStatusMessage() {
    let ed = this.ui.sourceEditor;
    return ed.setStatusMessage.apply(ed, arguments);
  }

  focus(evt) {
    let {metaInfoText, sourceEditor} = this.ui,
        t = evt && evt.targetMorph === metaInfoText ?
          metaInfoText : sourceEditor;
    t.focus();
  }

  get keybindings() {
    return [
      {keys: {mac: "Meta-S", win: "Ctrl-S"}, command: "browser save"},
      {keys: "Alt-Up",                       command: "focus list with selection"},
      {keys: "F1",                           command: "focus module list"},
      {keys: "F2",                           command: "focus code entities"},
      {keys: "F3|Alt-Down",                  command: "focus source editor"},
      {keys: "F4",                           command: "resize editor panel"},
      {keys: "Alt-R",                        command: "reload module"},
      {keys: "Alt-Ctrl-R",                   command: {command: "reload module", args: {hard: true}}},
      {keys: "Alt-L",                        command: "load or add module"},
      {keys: "Ctrl-C Ctrl-T",                command: "run all tests in module"},
      {keys: "Ctrl-C T",                     command: "run tests at point"},
      {keys: "Ctrl-C B E F",                 command: "run setup code of tests (before and beforeEach)"},
      {keys: "Ctrl-C A F T",                 command: "run teardown code of tests (after and afterEach)"},
      {keys: "Alt-P",                        command: "browser history backward"},
      {keys: "Alt-N",                        command: "browser history forward"},
      {keys: "Alt-H",                        command: "browser history browse"},
      {keys: "Meta-Shift-L b a c k e n d",   command: "activate eval backend dropdown list"},
      {keys: "Alt-J",                        command: "jump to codeentity"}
    ].concat(super.keybindings);
  }

  get commands() {
    return browserCommands(this)
      .concat(EvalBackendChooser.default.activateEvalBackendCommand(this));
  }

  async onContextMenu(evt) {
    evt.stop();

    var target = evt.targetMorph;
    var {
      sourceEditor,
      moduleList,
      codeEntityTree
    } = this.ui;

    var items = [];
    if ([sourceEditor, moduleList, codeEntityTree].includes(target))
      items.push(...await target.menuItems());

    this.openMenu([...items, ...await this.menuItems()], evt);
  }

  browseSnippetForSelection() {
    // produces a string that, when evaluated, will open the browser at the
    // same location it is at now
    let p = this.selectedPackage,
        m = this.selectedModule,
        c = this.selectedCodeEntity,
        sysI = this.systemInterface;

    let codeSnip = "$world.execCommand(\"open browser\", {";
    if (m) {
      if (m) codeSnip += `moduleName: "${p.name}/${m.nameInPackage}"`;
    } else {
      if (p) codeSnip += `packageName: "${p.name}"`;
    }
    if (c) {
      let codeEntities = this.ui.codeEntityTree.nodes;
      let needsDeDup = codeEntities.filter(ea => ea.name === c.name).length > 1;
      if (needsDeDup)
        codeSnip += `, codeEntity: ${JSON.stringify(obj.select(c, ["name", "type"]))}`;
      else
        codeSnip += `, codeEntity: "${c.name}"`;
    }

    if (sysI.name !== "local") codeSnip += `, systemInterface: "${sysI.name}"`;
    codeSnip += "});";

    return codeSnip;
  }

  menuItems() {
    let p = this.selectedPackage,
        m = this.selectedModule;

    return [
      p && {command: "open browse snippet", target: this},
      m && {command: "open selected module in text editor", target: this},
    ].filter(Boolean);
  }
}
