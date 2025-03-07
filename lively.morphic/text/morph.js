/*global System,Map,WeakMap,Shapes,Intersection*/
import { Rectangle, Point, rect, Color, pt } from "lively.graphics";
import { string, obj, fun, promise, arr } from "lively.lang";
import { signal, connect, disconnect } from "lively.bindings";

import { config, morph, Morph } from "../index.js";
import { Selection, MultiSelection } from "./selection.js";
import Document, {objectReplacementChar} from "./document.js";
import { Anchor } from "./anchors.js";
import { Range } from "./range.js";
import { eqPosition, lessPosition } from "./position.js";
import KeyHandler from "../events/KeyHandler.js";
import { Label } from "./label.js";
import { UndoManager } from "../undo.js";
import { TextSearcher } from "./search.js";
import TextLayout from "./layout.js";
import Renderer, { extractHTMLFromTextMorph } from "./renderer.js";
import commands from "./commands.js";
import { textAndAttributesWithSubRanges } from "./attributes.js";
import { serializeMorph, deserializeMorph } from "../serialization.js";
import { getSvgVertices } from "../rendering/property-dom-mapping.js";

export class Text extends Morph {

  static makeLabel(value, props) {
    return new Label({
      value,
      fontFamily: "Helvetica Neue, Arial, sans-serif",
      fontColor: Color.almostBlack,
      fontSize: 11,
      ...props
    });
  }

  static makeInputLine(props) {
    // hack to break up the cyclic dependency for now  without having to
    // update the imports all over the place
    const InputLine = (lively.morphic ? lively.morphic.InputLine : lively.modules.module('lively.morphic').recorder.InputLine);
    return new InputLine(props);
  }

  static get defaultTextStyle() {
    if (this._defaultTextStyle) return this._defaultTextStyle;
    let {properties} = this.prototype.propertiesAndPropertySettings(),
        propNames = this.defaultTextStyleProps,
        style = {};
    for (let i = 0; i < propNames.length; i++) {
      let name = propNames[i];
      style[name] = properties[name].defaultValue;
    }
    return (this._defaultTextStyle = style);
  }

  static get defaultTextStyleProps() {
    if (this._defaultTextStyleProps) return this._defaultTextStyleProps;
    let {properties} = this.prototype.propertiesAndPropertySettings(), styleProps = [];
    for (let prop in properties)
      if (properties[prop].isDefaultTextStyleProp) styleProps.push(prop);
    return (this._defaultTextStyleProps = styleProps);
  }



  static get properties() {
    return {
      clipMode: {
        isStyleProp: true,
        defaultValue: "visible",
        set(value) {
          this.setProperty("clipMode", value);
          this.fixedWidth = this.fixedHeight = this.isClip();
        }
      },

      fontMetric: {
        group: "_rendering",
        serialize: false,
        get() {
          return this.getProperty("fontMetric") || this.env.fontMetric;
        }
      },

      undoManager: {
        group: "core",
        before: ["document"],
        initialize() {
          this.ensureUndoManager();
        }
      },

      textRenderer: {
        group: "_rendering",
        after: ["viewState"],
        initialize() {
          this.textRenderer = new Renderer(this.env.domEnv);
        }
      },

      debug: {
        group: "_debugging",
        isStyleProp: true,
        after: ["textRenderer", "textLayout"],
        defaultValue: false,
        doc: "For visualizing and debugging text layout and rendering"
      },

      defaultViewState: {
        group: "_rendering",
        derived: true,
        readOnly: true,
        get() {
          return {
            _needsFit: true,
            text_layer_node: null,
            fontmetric_text_layer_node: null,
            dom_nodes: [],
            dom_nodeFirstRow: [],
            scrollTop: 0,
            scrollHeight: 0,
            scrollBottom: 0,
            textHeight: 0,
            textWidth: 0,
            firstVisibleRow: 0,
            lastVisibleRow: 0,
            heightBefore: 0,
            wasScrolled: false,
            afterTextRenderHook: null,
            fastScroll: true
          };
        }
      },

      viewState: {
        group: "_rendering",
        initialize() {
          this.viewState = this.defaultViewState;
        }
      },

      displacingMorphMap: {
        group: '_rendering',
        initialize() {
          this.displacingMorphMap = new Map();  
        }
      },

      embeddedMorphMap: {
        group: "_rendering",
        initialize() {
          this.embeddedMorphMap = new Map();
        }
      },

      embeddedMorphs: {
        group: "text",
        derived: true,
        readOnly: true,
        after: ["embeddedMorphMap"],
        get() {
          return this.embeddedMorphMap ? Array.from(this.embeddedMorphMap.keys()) : [];
        }
      },

      textLayout: {
        group: "_rendering",
        after: ["textRenderer"],
        initialize() {
          this.textLayout = new TextLayout(this);
        }
      },

      document: {
        group: "text",
        initialize() {
          this.document = Document.fromString("", {
            maxLeafSize: 50,
            minLeafSize: 25,
            maxNodeSize: 35,
            minNodeSize: 7
          });
          this.consistencyCheck();
        }
      },

      draggable: {defaultValue: false},

      useSoftTabs: {
        group: "text",
        isStyleProp: true,
        defaultValue: config.text.useSoftTabs !== undefined ? config.text.useSoftTabs : true
      },

      tabWidth: {
        group: "text",
        isStyleProp: true,
        defaultValue: config.text.tabWidth || 2
      },

      tab: {
        group: "text",
        isStyleProp: true,
        after: ["useSoftTabs", "tabWidth"],
        readOnly: true,
        get() { return this.useSoftTabs ? " ".repeat(this.tabWidth) : "\t"; }
      },

      autoInsertPairs: {
        group: "text",
        defaultValue: true
      },

      extent: {
        get() {
          let initialExtent = this.getProperty('extent');
          if (!this._textChange && this.viewState && 
              this.viewState._needsFit && !this._rendering &&
              !this._measuringTextBox && !!initialExtent) {
            let renderer = this.env.renderer;
            let textRenderer = this.textRenderer;
            if (!renderer || !textRenderer) return initialExtent;
            this._measuringTextBox = true;
            renderer.renderStep();
            textRenderer.manuallyTriggerTextRenderHook(this, renderer);
            this._measuringTextBox = false;
          }
          return this.getProperty('extent');
        }
      },

      fixedWidth: {
        group: "text",
        isStyleProp: true,
        after: ["clipMode", "viewState"],
        defaultValue: false
      },

      fixedHeight: {
        group: "text",
        isStyleProp: true,
        after: ["clipMode", "viewState"],
        defaultValue: false
      },

      readOnly: {
        group: "text",
        isStyleProp: true,
        defaultValue: false,
        set(value) {
          this.nativeCursor = value ? "default" : "auto";
          this.setProperty("readOnly", value);
        }
      },

      selectable: {
        group: "selection",
        isStyleProp: true,
        after: ["selection"],
        defaultValue: true,
        set(value) {
          this.setProperty("selectable", value);
          if (!value) this.selection.collapse();
        }
      },

      padding: {
        group: "styling",
        type: "Rectangle",
        isStyleProp: true,
        after: ["textLayout", "viewState"],
        defaultValue: Rectangle.inset(0),
        set(value) {
          this.setProperty(
            "padding",
            typeof value === "number" ? Rectangle.inset(value) : value
          );
        }
      },

      haloShadow: {
        group: "styling",
        type: 'Shadow',
        isStyleProp: true,
        defaultValue: null
      },

      highlightWhenFocused: {
        group: "styling",
        defaultValue: false, after: ["haloShadow"],
        set(val) {
          this.setProperty("highlightWhenFocused", val);
          if (val && !this.haloShadow) {
            this.haloShadow = {
              blur: 6,
              color: Color.rgb(52,152,219),
              distance: 0,
              rotation: 45
            }
          }
        }
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // selection

      cursorPosition: {
        group: "selection",
        derived: true,
        after: ["selection"],
        get() {
          return this.selection.lead;
        },
        set(p) {
          this.selection.range = {start: p, end: p};
        }
      },

      selection: {
        group: "selection",
        derived: true,
        after: ["document", "anchors"],
        get() {
          var sel = this.getProperty("selection");
          if (sel) return sel;
          sel = new (config.text.useMultiSelect ? MultiSelection : Selection)(this);
          this.setProperty("selection", sel);
          return sel;
        },
        set(selOrRange) {
          if (!selOrRange) {
            if (this.selection.isMultiSelection) {
              this.selection.disableMultiSelect();
            }
            this.selection.collapse();
          } else if (selOrRange.isSelection) this.setProperty("selection", selOrRange);
          else this.selection.range = selOrRange;
        }
      },

      selections: {
        group: "selection",
        derived: true,
        after: ["selection"],
        get() {
          return this.selection.isMultiSelection ? this.selection.selections : [this.selection];
        },

        set(sels) {
          this.selection = sels[0];
          if (!this.selection.isMultiSelection) return;
          sels.slice(1).forEach(ea => this.selection.addRange(ea));
        }
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // content

      textString: {
        group: "text",
        after: ["document"],
        derived: true,
        get() {
          return this.document ? this.document.textString : "";
        },
        set(value) {
          value = (value != null) ? String(value) : "";
          this.deleteText({start: {column: 0, row: 0}, end: this.document.endPosition});
          this.insertText(value, {column: 0, row: 0});
        }
      },

      value: {
        group: "text",
        after: ["document", "embeddedMorphMap"],
        derived: true,
        get() {
          var {textAndAttributes} = this;
          if (textAndAttributes.length === 1) {
            var [text, style] = textAndAttributes[0];
            if (!Object.keys(style || {}).length) return text;
          }
          return textAndAttributes;
        },
        set(value) {
          typeof value === "string"
            ? (this.textString = value)
            : (this.textAndAttributes = value);
        }
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // default font styling

      textAndAttributes: {
        group: "text",
        derived: true,
        after: ["document"],
        get() {
          return this.document.textAndAttributes;
        },
        set(textAndAttributes) {
          this.replace(
            {start: {row: 0, column: 0}, end: this.documentEndPosition},
            textAndAttributes
          );
        }
      },

      defaultTextStyleProps: {
        group: "_internal",
        readOnly: true,
        derived: true,
        get() {
          return this.constructor.defaultTextStyleProps;
        }
      },

      defaultTextStyle: {
        group: "styling",
        after: ["viewState"],
        derived: true,
        get() {
          return obj.select(this, this.defaultTextStyleProps);
        },
        set(style) {
          Object.assign(this, style);
        }
      },

      customizedTextStyle: {
        group: "styling",
        readOnly: true,
        derived: true,
        get() {
          let style = {},
              props = this.defaultTextStyleProps,
              defaultStyle = this.constructor.defaultTextStyle;
          for (let i = 0; i < props.length; i++) {
            let name = props[i], val = this[name];
            if (val !== defaultStyle[name]) style[name] = val;
          }
          return style;
        }
      },

      nativeCursor: {defaultValue: "", isDefaultTextStyleProp: true},

      fontFamily: {
        group: "text styling",
        type: "Enum",
        values: config.text.basicFontItems,
        defaultValue: "Sans-Serif",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },

      fontSize: {
        group: "text styling",
        type: "Number",
        min: 1,
        unit: "pt",
        defaultValue: 12,
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },

      selectionColor: {
        group: "text styling",
        type: "Color",
        defaultValue: Color.rgba(212,230,241,0.8),
        isStyleProp: true,
        after: ["defaultTextStyle"]
      },

      cursorColor: {
        group: "text styling",
        type: "Color",
        isStyleProp: true,
        after: ["defaultTextStyle"],
        defaultValue: Color.black
      },

      fontColor: {
        group: "text styling",
        type: "Color",
        defaultValue: Color.black,
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },

      fontWeight: {
        group: "text styling",
        type: "Enum",
        values: ["bold", "bolder", "light", "lighter", "normal"],
        defaultValue: "normal",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },

      fontStyle: {
        group: "text styling",
        type: "Enum",
        values: ["normal", "italic", "oblique"],
        defaultValue: "normal",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },

      textDecoration: {
        group: "text styling",
        type: "Enum",
        values: ['none', 'underline'],
        defaultValue: "none",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },
      textStyleClasses: {
        group: "text styling",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },
      backgroundColor: {
        group: "text styling",
        type: "Color",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["defaultTextStyle"]
      },
      textAlign: {
        group: "text styling",
        type: "Enum",
        values: ["center", "justify", "left", "right"],
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["document", "defaultTextStyle", "viewState"]
      },
      lineHeight: {
        group: "text styling",
        type: "Number",
        min: 1,
        isFloat: true,
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        defaultValue: 1.4,
        after: ["document", "defaultTextStyle", "viewState"]
      },
      letterSpacing: {
        group: "text styling",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["document", "defaultTextStyle", "viewState"]
      },
      wordSpacing: {
        group: "text styling",
        isStyleProp: true,
        isDefaultTextStyleProp: true,
        after: ["document", "defaultTextStyle", "viewState"]
      },

      lineWrapping: {
        // possible values:
        // false: no line wrapping, lines are as long as authored
        // true or "by-words": break lines at word boundaries. If not possible break line
        // anywhere to enforce text width
        // only-by-words: break lines at word boundaries. If not possible, line will be
        // wider than text
        // by-chars: Break line whenever character sequence reaches text width
        group: "text",
        type: 'Enum',
        values: [false, true, 'by-words', 'anywhere', 'only-by-words', 'wider', 'by-chars'],
        isStyleProp: true,
        defaultValue: false,
        after: ["document", "viewState"]
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // anchors – positions in text that move when text is changed
      anchors: {
        group: "core",
        defaultValue: [],
        set(anchors) {
          let newAnchors = arr.withoutAll(anchors, this.anchors),
              toRemove = arr.withoutAll(this.anchors, anchors);
          toRemove.forEach(ea => this.removeAnchor(ea));
          newAnchors.forEach(ea => this.addAnchor(ea));
        }
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // markers
      markers: {
        group: "core",
        defaultValue: []
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // marks
      savedMarks: {
        group: "core",
        defaultValue: [],
        after: ["anchors"],
        set(val) {
          var savedMarks = this.savedMarks;
          val = val.map(
            ea =>
              ea.isAnchor ? ea : this.addAnchor({...ea, id: "saved-mark-" + string.newUUID()})
          );
          var toRemove = this.savedMarks.filter(ea => !val.includes(ea));
          if (val > config.text.markStackSize)
            toRemove.push(...val.splice(0, val.length - config.text.markStackSize));
          toRemove.map(ea => this.removeAnchor(ea));
          return this.setProperty("savedMarks", val);
        }
      },

      activeMarkPosition: {
        group: "_internal",
        after: ["activeMark"],
        derived: true,
        get() {
          var m = this.activeMark;
          return m ? m.position : null;
        }
      },

      activeMark: {
        group: "core",
        after: ["anchors"],
        set(val) {
          if (val)
            val = this.addAnchor(
              val.isAnchor ? val : {...val, id: "saved-mark-" + string.newUUID()}
            );
          else {
            var m = this.activeMark;
            if (!this.savedMarks.includes(m)) this.removeAnchor(m);
          }
          this.setProperty("activeMark", val);
        }
      },

      // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
      // plugins
      plugins: {
        group: "plugins",
        defaultValue: [],
        after: ["value"],
        set(plugins) {
          var prevPlugins = this.getProperty("plugins"),
              removed = arr.withoutAll(prevPlugins, plugins);
          removed.forEach(p => p && this.removePlugin(p));
          plugins.forEach(p => p && this.addPlugin(p));
        }
      },

      editorModeName: {
        group: "plugins",
        derived: true, after: ["plugins"],
        get() {
          let p = this.editorPlugin;
          return p ? p.shortName : null;
        },
        set(nameOrMode) { this.changeEditorMode(nameOrMode); }
      }

    };
  }

  constructor(props = {}) {
    var {
      position,
      rightCenter,
      leftCenter,
      topCenter,
      bottom,
      top,
      right,
      left,
      bottomCenter,
      bottomLeft,
      bottomRight,
      topRight,
      topLeft,
      center
    } = props;

    super(props);

    this.undoManager.reset();

    this.fit();

    // Update position after fit
    if (position !== undefined) this.position = position;
    if (rightCenter !== undefined) this.rightCenter = rightCenter;
    if (leftCenter !== undefined) this.leftCenter = leftCenter;
    if (topCenter !== undefined) this.topCenter = topCenter;
    if (bottom !== undefined) this.bottom = bottom;
    if (top !== undefined) this.top = top;
    if (right !== undefined) this.right = right;
    if (left !== undefined) this.left = left;
    if (bottomCenter !== undefined) this.bottomCenter = bottomCenter;
    if (bottomLeft !== undefined) this.bottomLeft = bottomLeft;
    if (bottomRight !== undefined) this.bottomRight = bottomRight;
    if (topRight !== undefined) this.topRight = topRight;
    if (topLeft !== undefined) this.topLeft = topLeft;
    if (center !== undefined) this.center = center;
  }

  __deserialize__(snapshot, objRef, pool) {
    super.__deserialize__(snapshot, objRef);
    
    this.viewState = this.defaultViewState;
    this.markers = [];
    this.textRenderer = new Renderer(this.env.domEnv);
    this.textLayout = new TextLayout(this);
    this.changeDocument(Document.fromString(""));
    this.ensureUndoManager();
    this._isDeserializing = true;
  }

  __after_deserialize__(snapshot, objRef) {
    super.__after_deserialize__(snapshot, objRef);
    let lines, line, cacheEntry;
    if (snapshot._cachedLineCharBounds) {
       this.changeMetaData('deserializeInfo', {recoveredLineCharBounds: true});
       lines = snapshot._cachedLineCharBounds;
       for (let row = 0; row < lines.length; row++) {
         if (line = lines[row]) {
           cacheEntry = [];
           this.textLayout.lineCharBoundsCache.set(this.document.getLine(row), cacheEntry);
           for (let i = 0; i < line.length; i += 4) {
             cacheEntry.push({
               height: line[i],
               width: line[i + 1],
               x: line[i + 2],
               y: line[i + 3],
             });
           }
         }
       }
    }
    if (snapshot._cachedLineExtents) {
      this.changeMetaData('deserializeInfo', {recoveredTextBounds: true});
      this.whenRendered().then(() => {
        for (let i = 0; i < Math.min(snapshot._cachedLineExtents.length, this.document.lines.length); i++) {
          let [width, height] = snapshot._cachedLineExtents[i];
          this.document.lines[i].changeExtent(width, height);
          this.fit();
        }
      });
    }
    this._isDeserializing = false;
    this.whenRendered().then(() => {
       this.embeddedMorphs.forEach(m => m.top = 0);
    })
  }

  get __only_serialize__() {
    return arr.withoutAll(super.__only_serialize__, [
      "document",
      "textRenderer",
      "viewState",
      "undoManager",
      "markers",
      "textLayout",
      "embeddedMorphMap"
    ]);
  }

  __additionally_serialize__(snapshot, objRef, pool, addFn) {
    super.__additionally_serialize__(snapshot, objRef, pool, addFn);
    snapshot.props.selections = {
      key: "selections",
      verbatim: true,
      value: (this.selection.isMultiSelection
        ? this.selection.ranges
        : [this.selection.range]).map(ea => obj.select(ea, ["start", "end"]))
    };

    // filter the anchors
    if (snapshot.props.anchors && this.selection.isEmpty()) {
      snapshot.props.anchors.value = snapshot.props.anchors.value.filter(ref => {
        return !ref.id.includes('selection-');
      });
    }

    snapshot.props.textAndAttributes = {
      key: "textAndAttributes",
      value: this.textAndAttributes.map(m => { 
          if (!m) return m; 
          if (m.isMorph) return pool.ref(m).asRefForSerializedObjMap();
          if (obj.isObject(m)) {
            let bindings = {},
                stringified = JSON.stringify(m, (k, v) => {
                  if (v && v.__serialize__) {
                    v = v.__serialize__();
                    Object.assign(bindings, v.bindings);
                    return "->" + `[${v.__expr__}]`
                  }
                  return v;
            });
            stringified = stringified.replace(/\"->\[.*\]\"/g, (m) => {
              return m.slice(4, -2)
            });
            return pool.expressionSerializer.exprStringEncode({
              __expr__: `(${stringified})`, // incorporate the bindings of each of the sub expressions
              bindings
            });
          }
          return m;
      })
    };
    snapshot._cachedLineExtents = this.document.lines.map(l => [l.width, l.height]);
    snapshot._cachedLineCharBounds = this.document.lines.map(l => {
      const hit = this.textLayout.lineCharBoundsCache.get(l);
      if (hit) {
         return arr.flatten(hit.map(({height, width, x, y}) => [height, width, x, y]))
      }
      return null;
    });
  }

  spec() {
    let spec = super.spec();
    spec.textString = this.textString;
    return obj.dissoc(spec, ['anchors', 'embeddedMorphMap', 'plugins', 'savedMarks', 'textLayout', 'textRenderer', 'viewState', 'undoManager', 'metadata', 'document', 'displacingMorphMap']);
  }

  get isText() {
    return true;
  }

  onChange(change) {
    let {prop, selector, meta} = change,
        wraps = this.lineWrapping,
        textChange = false,
        viewChange = false,
        softLayoutChange = false,
        hardLayoutChange = false,
        scrollChange = false,
        enforceFit = false,
        displacementChange = false;

    if (selector) {
      textChange = selector === "replace";
      hardLayoutChange = selector === 'addTextAttribute';
      this._displacementChange = !this._displacing && textChange;
    } else {
      switch (prop) {
        case 'scroll': viewChange = true; scrollChange = true; break;
        case 'extent': 
          viewChange = true;
          enforceFit = !this.fixedWidth || !this.fixedHeight;
          let delta = change.prevValue.subPt(change.value);
          softLayoutChange = this.fixedWidth && !!this.lineWrapping && !!delta.x;
          break;
        case "wordSpacing":
        case "letterSpacing":
        case "tabWidth": if (wraps) hardLayoutChange = true; break;
        case "fontFamily":
        case "fontSize":
        case "lineHeight":
        case "textAlign":
        case "fontWeight":
        case "fontStyle":
        case "textStyleClasses":
        case "fixedWidth":
          hardLayoutChange = change.prevValue != change.value;
          break;
        case "lineWrapping": hardLayoutChange = true; break;
        case 'borderWidth':
        case "fixedHeight": 
          softLayoutChange = change.prevValue != change.value;
          break;
        case "padding": softLayoutChange = true; break;
      }
    }

    super.onChange(change);
    
    let updateTextEngine = () => {

      this._textChange = true;

      if (scrollChange) this.viewState.wasScrolled = true;
      
      if (hardLayoutChange || 
          enforceFit ||
          (softLayoutChange && !meta.styleSheetChange)) {
        this.invalidateTextLayout(
          hardLayoutChange /*reset char bounds*/,
          hardLayoutChange /*reset line heights*/);
      }

      if (softLayoutChange || hardLayoutChange) {
        if (this.document && this.world()) this.document.lines.forEach(l => l.hasEstimatedExtent = true);
      }

      if (this._displacementChange) {
        this._displacementChange = false;
        // this.displacingMorphMap.forEach((_, m) => {
        //   this.updateTextDisplacementFor(m);
        // });
      }

      if (textChange) signal(this, "textChange", change);
      if (viewChange) signal(this, "viewChange", change);
      this._textChange = false;
    }
    
    // if there is an animation in progress, we need to wait until that
    // is finished animating, so that our dom measurement is not fucked up.
    if (meta.animation)
      promise.delay(meta.animation.duration).then(updateTextEngine)
    else {
       updateTextEngine(); 
    }
  }
  
  async onSubmorphChange(change, submorph) {
    if (change.meta && change.meta.styleSheetChange) return;
    super.onSubmorphChange(change, submorph);
    if (change.meta.animation) {
      await change.meta.animation.asPromise();
    }
    if (this._textChange || this._positioningSubmorph === submorph) {
      return;
    }
    let {prop} = change,
        isGeometricTransform = prop == 'position' ||
                               prop == 'extent' || 
                               prop == 'scale' || 
                               prop == 'rotation';
    
    // update the displacement shape if the bounds of a displacing morph changed
    if (this.displacingMorphMap.get(submorph) 
        && isGeometricTransform) {
       [...this.displacingMorphMap.keys()]
           .filter(m => m.top >= submorph.top)
           .forEach(m => {
         this._intersectionShapeCache && this._intersectionShapeCache.delete(m);
         this.updateTextDisplacementFor(m)
       })
    }
    
    const {anchor: submorphAnchor} = this.embeddedMorphMap.get(submorph) || {};
    if (submorphAnchor
        && isGeometricTransform) {
      if (prop == 'position') {
        // embedded morphs are fixed, so we just revert the position and are done
        this._positioningSubmorph = submorph;
        submorph.position = change.prevValue;
        this._positioningSubmorph = null;
        return;
      }
      const currentBounds = submorph.bounds(),
            lastBounds = submorph._lastBounds, // infer last bounds from the actual change
            row = submorphAnchor.position.row,
            line = this.document.getLine(row);
      if (!lastBounds || 
          lastBounds.height != currentBounds.height ||
          lastBounds.bottom() != currentBounds.bottom()) {
        line.hasEstimatedExtent = true;
        submorph._lastBounds = currentBounds;
      }
    }
  }

  removeMorph(morph, invalidateTextLayout = true) {
    let {embeddedMorphMap, displacingMorphMap} = this;
    if (displacingMorphMap && displacingMorphMap.has(morph)) {
      this.toggleTextWrappingAround(morph, false);
    }
    if (embeddedMorphMap && embeddedMorphMap.has(morph)) {
      let {anchor} = embeddedMorphMap.get(morph);
      if (anchor) {
        let {position: {row, column}} = anchor;
        this.replace({start: {row, column}, end: {row, column: column + 1}}, [], 
                     true, invalidateTextLayout);
        this.replace
      }
      embeddedMorphMap.delete(morph);
    }
    return super.removeMorph(morph);
  }

  toggleTextWrappingAround(submorph, wrapActive) {
    /*
      There are three ways to embedd morphs into a text morph:
      1.- the plain submorph, where the submorph floats above the text
      2.- the embedded morph, where the submorph is inline with the text, treated like
          another character
      3.- plain submorphs that wrap the text of the text morph depending 
          on their shape (float around)
      This function is for toggling the 3rd way on a given submorph. 
      If the given submorph is found to be currently inline with the text, 
      it is removed from the text and added again as a plain submorph with
      wrapping enabled/disabled;      
    */
    if (wrapActive) {
      if (this.displacingMorphMap.has(submorph)) return;
      if (this.embeddedMorphMap.has(submorph)) {
        this.addMorph(submorph.remove());
      }
      this.displacingMorphMap.set(submorph, []);
      this.updateTextDisplacementFor(submorph);
    } else {
      let displacementMorphs = this.displacingMorphMap.get(submorph);
      if (displacementMorphs) {
        this._displacing = true;
        displacementMorphs.forEach(dm => this.removeMorph(dm));
        this._displacing = false;
        this.displacingMorphMap.delete(submorph);
      }
    }
  }

  updateTextDisplacementFor(submorph) {
    if (this._displacing) return;
    this._displacing = true;
    let morphs = this.displacingMorphMap.get(submorph),
        rects = this.computeDisplacementRectsFor(submorph).values(), 
        curr = [];

    morphs.forEach(m => this.removeMorph(m, false));
    this.textLayout.resetLineCharBoundsCacheOfRange(this, submorph._displacementRange);
    var prevTop;
    for (let bounds of rects) {
      let m = morphs.shift() || morph({
            visible: true,
            reactsToPointer: false,
            isDisplacementMorph: true
          }),
          pos = this.textLayout.textPositionFromPoint(this, bounds.leftCenter());
      m.setBounds(bounds);
      this.insertText([m, {}], pos);
      this.viewState._needsFit = false;
      if (prevTop == m.top) {
        m.remove()
        continue;
      }
      prevTop = m.top;
      curr.push(m);
    }
    morphs.forEach(m => this.removeMorph(m, false));
    this.displacingMorphMap.set(submorph, curr);
    this._displacing = false;
  }
  
  computeDisplacementRectsFor(submorph) {
    // check what line ranges are overlapped by the morph
    let tl = this.textLayout,
        startPos = tl.textPositionFromPoint(this, submorph.topLeft),
        endPos = tl.textPositionFromPoint(this, submorph.bottomLeft),
        lineRanges = [],
        bufferDist = 15,
        computeIntersectionShape = (submorph) => {
          if (submorph.isPath) {
            return Shapes.path(getSvgVertices(submorph.vertices));
          } else if (submorph.constructor.name == 'Ellipse') {
            return Shapes.ellipse(
              submorph.center.x,
              submorph.center.y,        
              submorph.width / 2,
              submorph.height / 2)
          } else {
            return Shapes.rectangle(
              submorph.left, submorph.top, 
              submorph.width, submorph.height)
          }
        };

    submorph._displacementRange = Range.fromPositions(startPos, endPos);
    
    for (let row = startPos.row; row < endPos.row + 1; row++) {
      lineRanges.push(...tl.rangesOfWrappedLine(this, row))
    }
    if (!this._intersectionShapeCache) this._intersectionShapeCache = new Map();
    let hit = this._intersectionShapeCache.get(submorph),
        intersectionShape = hit || computeIntersectionShape(submorph);
    this._intersectionShapeCache.set(submorph, intersectionShape);
   
    var width = this.width, extrusionMap = new Map();
    for (let r of lineRanges) {
      let {height, y} = tl.computeMaxBoundsForLineSelection(this, r),
          lineRect = Shapes.rectangle(width, height, 0, y),
          is = Intersection.intersect(lineRect, intersectionShape);
      if (is.points.length < 1) continue;
      let displacementRect = Rectangle.unionPts(is.points.map(Point.fromLiteral))
      displacementRect.y = y;
      displacementRect.height = height;
      displacementRect.x -= bufferDist;
      displacementRect.width += 2 * bufferDist;
      extrusionMap.set(r, displacementRect); 
    }
    return extrusionMap;
  }

  rejectsInput() {
    return this.readOnly; /*|| !this.isFocused()*/
  }

  addAnchor(anchor) {
    if (!anchor) return;

    if (typeof anchor === "string") {
      anchor = {id: anchor, row: 0, column: 0};
    }

    if (!anchor.isAnchor) {
      let {id, column, row, insertBehavior} = anchor;
      anchor = new Anchor(
        id,
        typeof row === "number" && typeof column === "number" ? {row, column} : undefined,
        insertBehavior || "move"
      );
    }

    var existing = anchor.id && this.anchors.find(ea => ea.id === anchor.id);
    if (existing) return Object.assign(existing, anchor);

    this.anchors.push(anchor);
    return anchor;
  }

  removeAnchor(anchor) {
    // anchor can be anchor object or anchor id (string)
    let {anchors} = this, removed;
    for (let i = anchors.length; i--; ) {
      let a = anchors[i];
      if (a.id == anchor || a === anchor) {
        removed = a;
        anchors.splice(i, 1);
      }
    }
    return removed;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // markers, text ranges with styles that are rendered over/below the text and
  // do not influence the text appearance themselves
  addMarker(marker) {
    // id, range, style
    this.removeMarker(marker.id);
    this.markers.push(marker);
    this.makeDirty();
    return marker;
  }

  removeMarker(marker) {
    var id = typeof marker === "string" ? marker : marker.id;
    this.markers = this.markers.filter(ea => ea.id !== id);
    this.makeDirty();
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // marks: text position that are saved and can be retrieved
  // the activeMark affects movement commands: when it's active movement will
  // select

  saveMark(p = this.cursorPosition, activate) {
    var prevMark = this.activeMark;
    if (prevMark && prevMark !== p && !prevMark.equalsPosition(p))
      this.savedMarks = this.savedMarks.concat(prevMark);
    if (activate) this.activeMark = p;
    else this.savedMarks = this.savedMarks.concat(p);
  }

  saveActiveMarkAndDeactivate() {
    var m = this.activeMark;
    if (m) {
      this.saveMark(m);
      this.activeMark = null;
    }
  }

  popSavedMark() {
    var mark = this.activeMark;
    if (mark) {
      this.activeMark = null;
      return mark;
    }
    var last = arr.last(this.savedMarks);
    this.savedMarks = this.savedMarks.slice(0, -1);
    return last;
  }

  get lastSavedMark() {
    return this.activeMark || arr.last(this.savedMarks);
  }

  savedMarkForSelection(replacement) {
    // find the mark in $emacsMarkRing corresponding to the current
    // selection
    var {selection: sel, savedMarks} = this,
        multiRangeLength = this.multiSelect ? this.multiSelect.getAllRanges().length : 1,
        selIndex = sel.index || 0,
        markIndex = savedMarks.length - (multiRangeLength - selIndex),
        lastMark = savedMarks[markIndex] || sel.anchor;
    if (replacement && "row" in replacement && "column" in replacement) {
      this.savedMarks = savedMarks
        .slice(0, markIndex)
        .concat(replacement)
        .concat(savedMarks.slice(markIndex + 1));
    }
    return lastMark;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // plugins: objects that can attach/detach to/from text objects and react to
  // text changes as well as modify text however they see fit

  addPlugin(plugin) {
    if (!this.plugins.includes(plugin)) {
      this.plugins.push(plugin);
      this._cachedKeyhandlers = null;
      typeof plugin.attach === "function" && plugin.attach(this);
    }
    return plugin;
  }

  removePlugin(plugin) {
    if (!this.plugins.includes(plugin)) return false;
    this._cachedKeyhandlers = null;
    arr.remove(this.plugins, plugin);
    typeof plugin.detach === "function" && plugin.detach(this);
    return true;
  }

  pluginCollect(method, result = []) {
    this.plugins.forEach(p => typeof p[method] === "function" && (result = p[method](result)));
    return result;
  }

  pluginInvokeFirst(method, ...args) {
    var plugin = this.pluginFind(p => typeof p[method] === "function");
    return plugin ? plugin[method](...args) : undefined;
  }

  pluginFind(iterator) {
    return this.plugins.slice().reverse().find(iterator);
  }

  get editorPlugin() {
    return this.pluginFind(ea => ea.isEditorPlugin);
  }

  async lookupEditorPluginNamed(modeName) {
    // let modeName = "js"
    modeName = config.ide.modes.aliases[modeName] || modeName;
    let isAbsURL = /^[^:\\]+:\/\//.test(modeName),
        url = isAbsURL ? modeName : `lively.ide/${modeName}/editor-plugin.js`;
    if (!await lively.modules.doesModuleExist(url)) return null;
    let {default: Mode} = await lively.modules.module(url).load();
    return Mode;
  }

  async changeEditorMode(nameOrMode) {
    // let nameOrMode = "js"

    let pluginsWithoutModes = this.plugins.filter(ea => !ea.isEditorPlugin);

    if (!nameOrMode) {
      // disbale
      this.plugins = pluginsWithoutModes;
      return null;
    }

    if (typeof nameOrMode === "string") {
      let Mode = await this.lookupEditorPluginNamed(nameOrMode);
      if (!Mode) throw new Error(`Cannot find editor mode ${nameOrMode}`);
      nameOrMode = new Mode(config.codeEditor.defaultTheme);
    }

    this.plugins = pluginsWithoutModes.concat(nameOrMode);
    return nameOrMode;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  invalidateTextLayout(resetCharBoundsCache = false, resetLineHeights = false) {
    if (this._isDeserializing) return;
    let vs = this.viewState;
    if (!vs) return;
    if (!this.fixedWidth || !this.fixedHeight) vs._needsFit = true;
    let tl = this.textLayout;
    if (tl) {
      if (resetCharBoundsCache) tl.resetLineCharBoundsCache(this);
      tl.estimateLineHeights(this, resetLineHeights);
    }
  }

  textBounds() { return this.textLayout.textBounds(this); }

  defaultCharExtent() { return this.textLayout.defaultCharExtent(this); }

  get scrollExtent() {
    // rms: See: morph>>scrollExtent
    return this.textBounds()
      .extent()
      .addPt(this.padding.topLeft())
      .addPt(this.padding.bottomRight())
      .addPt(this.scrollbarOffset)
      .maxPt(super.scrollExtent);
  }

  get commands() {
    return this.pluginCollect("getCommands", (this._commands || []).concat(commands));
  }

  execCommand(commandOrName, args, count, evt) {
    var {name, command} = this.lookupCommand(commandOrName) || {};
    if (!command) return undefined;

    var multiSelect = this.inMultiSelectMode(),
        multiSelectAction = command.hasOwnProperty("multiSelectAction")
          ? command.multiSelectAction
          : "forEach";

    // first we deal with multi select, if the command doesn't handle it
    // itsself. From inside here we just set the selection to each range in the
    // multi selection and then let the comand run normally
    if (multiSelect && multiSelectAction === "forEach") {
      var origSelection = this.selection,
          selections = this.selection.selections.slice().reverse();
      this.selection = selections[0];
      this._multiSelection = origSelection;

      try {
        var result = this.execCommand(commandOrName, args, count, evt);
      } catch (err) {
        this.selection = origSelection;
        this._multiSelection = null;
        this.selection.mergeSelections();
        throw err;
      }

      if (!result) return result;
      var results = [result];

      if (typeof result.then === "function" && typeof result.catch === "function") {
        return promise.finally(
          promise
            .chain(
              [() => result].concat(
                selections.slice(1).map(sel => () => {
                  this.selection = sel;
                  return Promise.resolve(
                    this.execCommand(commandOrName, args, count, evt)
                  ).then(result => results.push(result));
                })
              )
            )
            .then(() => results),
          () => {
            this.selection = origSelection;
            this._multiSelection = null;
            this.selection.mergeSelections();
          }
        );
      } else {
        try {
          for (var sel of selections.slice(1)) {
            this.selection = sel;
            results.push(this.execCommand(commandOrName, args, count, evt));
          }
        } finally {
          this.selection = origSelection;
          this._multiSelection = null;
          this.selection.mergeSelections();
        }
        return results;
      }
    }

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // Here we know that we don't have to deal with multi select and directly
    // call the command handler

    var result = this.commandHandler.exec(commandOrName, this, args, count, evt);

    if (result) {
      if (typeof result.then === "function" && typeof result.catch === "function")
        result.then(() => cleanupScroll(this));
      else cleanupScroll(this);
    }

    return result;

    function cleanupScroll(morph) {
      var scrollCursorIntoView = command.hasOwnProperty("scrollCursorIntoView")
        ? command.scrollCursorIntoView
        : true;
      if (scrollCursorIntoView)
        fun.debounceNamed("execCommand-scrollCursorIntoView-" + morph.id, 100, () =>
          morph.scrollCursorIntoView()
        )();
    }
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // document changes

  changeDocument(doc, resetStyle = false) {
    if (this.document) var defaultTextStyle = this.defaultTextStyle;
    else resetStyle = false;
    this.document = doc;
    this.textLayout.reset();
    if (resetStyle) this.defaultTextStyle = defaultTextStyle;
    this.makeDirty();
    this.consistencyCheck();
  }

  textInRange(range) {
    return this.document.textInRange(range);
  }
  charRight({row, column} = this.cursorPosition) {
    return this.getLine(row).slice(column, column + 1);
  }
  charLeft({row, column} = this.cursorPosition) {
    return this.getLine(row).slice(column - 1, column);
  }

  indexToPosition(index) {
    return this.document.indexToPosition(index);
  }
  positionToIndex(position) {
    return this.document.positionToIndex(position);
  }

  getVisibleLine(row = this.cursorPosition.row) {
    return this.textLayout.wrappedLines(this)[row].text;
  }

  isLineVisible(row = this.cursorPosition.row) {
    return this.textLayout.isLineVisible(this, row);
  }

  isLineFullyVisible(row = this.cursorPosition.row) {
    return this.textLayout.isLineFullyVisible(this, row);
  }

  getLine(row = this.cursorPosition.row) {
    return this.document.getLineString(row);
  }

  lineCount() {
    return this.document.rowCount;
  }

  isLineEmpty(row) {
    return !this.getLine(row).trim();
  }
  isAtLineEnd(pos = this.cursorPosition) {
    var line = this.getLine(pos.row);
    return pos.column === line.length;
  }

  wordsOfLine(row = this.cursorPosition.row) {
    return this.document.wordsOfLine(row);
  }
  wordAt(pos = this.cursorPosition) {
    return this.document.wordAt(pos);
  }
  wordLeft(pos = this.cursorPosition) {
    return this.document.wordLeft(pos);
  }
  wordRight(pos = this.cursorPosition) {
    return this.document.wordRight(pos);
  }

  lineRange(row = this.cursorPosition.row, ignoreLeadingWhitespace = true) {
    if (typeof row !== "number") this.cursorPosition.row;
    var line = this.getLine(row),
        range = {start: {column: 0, row}, end: {column: line.length, row}},
        leadingSpace = line.match(/^\s*/);
    if (leadingSpace[0].length && ignoreLeadingWhitespace)
      range.start.column += leadingSpace[0].length;
    return new Range(range);
  }

  screenLineRange(pos = this.cursorPosition, ignoreLeadingWhitespace = true) {
    return this.textLayout.screenLineRange(this, pos, ignoreLeadingWhitespace);
  }

  insertTextAndSelect(text, pos = null) {
    text = String(text);
    if (pos) this.selection.range = this.insertText(text, pos);
    else this.selection.text = text;
  }

  append(text) {
    return this.saveExcursion(() => this.insertText(text, this.documentEndPosition));
  }

  insertText(
    textOrtextAndAttributes,
    pos = this.cursorPosition,
    extendTextAttributes = true,
    invalidateTextLayout = true
  ) {
    return this.replace(
      {start: pos, end: pos},
      textOrtextAndAttributes,
      extendTextAttributes,
      invalidateTextLayout);
  }

  deleteText(range, invalidateTextLayout = true) {
    let removedTextAndAttributes = this.textAndAttributesInRange(range);
    this.replace(range, [], false, invalidateTextLayout);
    return removedTextAndAttributes;
  }

  replace(
    range,
    textOrtextAndAttributes,
    extendTextAttributes = true,
    invalidateTextLayout = true,
    undoGroup = true,
    consistencyCheck = true
  ) {
    range = range.isRange ? range : new Range(range);

    // convert insertion into text and attibutes
    let textAndAttributes = typeof textOrtextAndAttributes === "string"
      ? [textOrtextAndAttributes, null]
      : Array.isArray(textOrtextAndAttributes)
          ? textOrtextAndAttributes
          : [String(textOrtextAndAttributes || ""), null];

    let nothingToInsert =
      !textAndAttributes.length || (textAndAttributes.length == 2 && !textAndAttributes[0]),
        nothingToDelete = range.isEmpty();

    if (nothingToInsert && nothingToDelete) return range;

    let attrToExtend;
    if (extendTextAttributes) {
      attrToExtend = this.textAttributeAt({
        row: range.start.row,
        column: range.start.column - (range.start.column > 0 ? 1 : 0)
      });
    }

    let morphsInAddedText = [];
    for (let i = 0; i < textAndAttributes.length; i = i + 2) {
      let content = textAndAttributes[i], attrs = textAndAttributes[i + 1];
      if (content.isMorph) morphsInAddedText.push(content);
      if (attrToExtend) textAndAttributes[i + 1] = {...attrToExtend, ...attrs};
    }

    undoGroup && this.undoManager.undoStart(this, "replace");

    let removedTextAndAttributes = this.textAndAttributesInRange(range),
        {inserted: insertedRange} = this.document.replace(
          range,
          textAndAttributes,
          this.debug && this.debugHelper(this.debug));

    this.addMethodCallChangeDoing(
      {
        target: this,
        selector: "replace",
        args: [range, textAndAttributes],
        undo: {
          target: this,
          selector: "replace",
          args: [insertedRange, removedTextAndAttributes, false]
        }
      },
      () => {
        if (invalidateTextLayout) {
          this.invalidateTextLayout(false, false);
          this.textLayout.resetLineCharBoundsCacheOfRange(this, insertedRange);
        }
        if (!eqPosition(range.end, insertedRange.end)) {
          if (lessPosition(insertedRange.end, range.end)) {
            let [removedRange] = new Range(range).subtract(insertedRange);
            this.anchors.forEach(ea => ea.onDelete(removedRange));
          } else {
            let [addedRange] = new Range(insertedRange).subtract(range);
            this.anchors.forEach(ea => ea.onInsert(addedRange));
          }
          // When auto multi select commands run, we replace the actual selection
          // with individual normal selections
          if (this._multiSelection) this._multiSelection.updateFromAnchors();
          else this.selection.updateFromAnchors();
        }

        this._updateEmbeddedMorphsDuringReplace(
          morphsInAddedText,
          insertedRange,
          textAndAttributes,
          removedTextAndAttributes);

        this.textLayout.estimateLineHeights(this, false);
        
        if (consistencyCheck)
          this.consistencyCheck();
      });

    undoGroup && this.undoManager.undoStop();

    return insertedRange;
  }

  _updateEmbeddedMorphsDuringReplace(
    morphsInAddedText,
    insertedRange,
    newTextAndAttributes,
    removedTextAndAttributes
  ) {
    let {embeddedMorphMap} = this;
    for (let i = 0; i < removedTextAndAttributes.length; i = i + 2) {
      let content = removedTextAndAttributes[i];
      if (content.isMorph && !morphsInAddedText.includes(content)) {
        if (embeddedMorphMap) {
          let existing = embeddedMorphMap.get(content);
          if (existing && existing.anchor) {
            this.removeAnchor(existing.anchor);
            disconnect(existing.anchor, "position", content, "position");
          }
          embeddedMorphMap.set(content, {...existing, anchor: null});
        }
        content.remove();
      }
    }
    if (morphsInAddedText.length) {
      let {ranges, textAndAttributes} = textAndAttributesWithSubRanges(
        insertedRange.start,
        newTextAndAttributes
      );

      for (let i = 0; i < ranges.length; i++) {
        let morph = textAndAttributes[i * 2];
        if (!morph.isMorph) continue;
        console.assert(morphsInAddedText.includes(morph), "????");
        let {start} = ranges[i];

        if (morph.owner !== this) this.addMorph(morph);
        // anchor are not able to move correctly, if we replace text and attributes
        // with new positions of the morphs, which may be arbitrary (oftentimes not possible
        // to infer the movement). We therefore need to replace these anchor at all times
        
        if (embeddedMorphMap) {
           if (embeddedMorphMap.has(morph)) {
              embeddedMorphMap.get(morph).anchor.position = start;
              continue;
           }
           let anchor = this.addAnchor({id: "embedded-" + morph.id, ...start});
            connect(anchor, "position", morph, "position", {
              updater: function($upd, textPos) {
                let tm = this.targetObj.owner,
                    embeddedMorph = this.targetObj,
                    pos = tm ? tm.charBoundsFromTextPosition(textPos).topLeft().subPt(tm.origin) : embeddedMorph.position;
                if (tm) tm._positioningSubmorph = embeddedMorph;
                $upd(pos);
                if (tm) tm._positioningSubmorph = false;
              }
            }).update(anchor.position);
            embeddedMorphMap.set(morph, {anchor});
        }
      }

      // let {start, end} = insertedRange, found;
      // while (start && (found = this.search(objectReplacementChar, {inRange: {start, end}}))) {
      //   let {range} = found,
      //       morph = this.textAndAttributesInRange(range)[0];
      //   start = lessPosition(range.end, end) ? range.end : null;
      //   if (!morph.isMorph) {
      //     console.warn(`[inserting morph into text] content marked as morph is not a morph: ${morph}`);
      //     continue;
      //   }
      //   if (morph.owner !== this) this.addMorph(morph);
      //   if (embeddedMorphMap && !embeddedMorphMap.has(morph)) {
      //     let anchor = this.addAnchor({id: "embedded-" + morph.id, ...range.start});
      //     connect(anchor, 'position', morph, 'position', {
      //       converter: function(textPos) {
      //         return this.targetObj.owner.charBoundsFromTextPosition(textPos).topLeft();
      //       }
      //     }).update(anchor.position);
      //     embeddedMorphMap.set(morph, {anchor});
      //   }
      // }
    }
  }

  applyJsDiffPatch(patch) {
    let self = this, changes = [], pos = 0, offset = 0;
    for (let change of patch) {
      if (change.removed) {
        offset = remove(pos, pos + change.count, offset, changes);
      } else if (change.added) {
        offset = insert(pos, change.value, offset, changes);
      }
      pos += change.count;
    }
    return changes;

    function remove(startI, endI, offset, changes) {
      let start = self.indexToPosition(startI+offset),
          end = self.indexToPosition(endI+offset)
      changes.push(self.deleteText({start, end}));
      return offset - (endI-startI);
    }
    function insert(atI, text, offset, changes) {
      changes.push(self.insertText(text, self.indexToPosition(atI+offset)));
      return offset;
    }
  }

  applyTextChanges(changes, offset = 0, extendTextAttributes = true, invalidateTextLayout) {
    // format:
    // [
    //   ["remove", {row, column}, {row, column}],
    //   ["insert", {row, column}, "string"],
    // ]

    var changed = [];
    for (let [type, start, endOrText] of changes) {

      // 1. Apply offset
      if (offset) {
        var startIndex = typeof start === "number" ? start : this.positionToIndex(start);
        start = startIndex + offset;
        if (endOrText && (typeof endOrText !== "string" && !Array.isArray(endOrText))) {
          var endIndex = typeof endOrText === "number" ? endOrText : this.positionToIndex(endOrText);
          endOrText = endIndex + offset;
        }
        start = startIndex + offset;
      }

      var startPos = typeof start === "number" ? this.indexToPosition(start) : start;

      switch (type) {
        case 'delete': case 'remove':
          var endPos = typeof endOrText === "number" ? this.indexToPosition(endOrText) : endOrText;
          changed.push(this.deleteText({start: startPos, end: endPos}, invalidateTextLayout));
          break;
        case 'insert':
          changed.push(this.insertText(endOrText, startPos, extendTextAttributes, invalidateTextLayout));
          break;          
        default:
          console.warn(`[applyTextChanges] unknown type: ${type}`);
      }
    }

    return changed;
  }

  modifyLines(startRow, endRow, modifyFn) {
    var lines = arr.range(startRow, endRow).map(row => this.getLine(row)),
        modifiedText = lines.map(modifyFn).join("\n") + "\n";
    this.deleteText(
      {start: {row: startRow, column: 0}, end: {row: endRow + 1, column: 0}},
      false
    );
    this.insertText(modifiedText, {row: startRow, column: 0});
  }

  modifySelectedLines(modifyFn) {
    var range = this.selection.isEmpty()
      ? this.lineRange(undefined, false)
      : this.selection.range;
    return this.modifyLines(range.start.row, range.end.row, modifyFn);
  }

  withLinesDo(startRow, endRow, doFunc) {
    return arr.range(startRow, endRow).map(row => {
      var line = this.getLine(row), range = Range.create(row, 0, row, line.length);
      return doFunc(line, range);
    });
  }

  withSelectedLinesDo(doFunc) {
    var range = this.selection.isEmpty()
      ? this.lineRange(undefined, false)
      : this.selection.range;
    var {start: {row: startRow}, end: {row: endRow, column: endColumn}} = range;
    // if selection is only in the beginning of last line don't include it
    return this.withLinesDo(
      startRow,
      endColumn === 0 && endRow > startRow ? endRow - 1 : endRow,
      doFunc
    );
  }

  joinLine(row = this.cursorPosition.row) {
    // joins line identified by row with following line
    // returns the position inside the joined line where the join happened
    var firstLine = this.getLine(row),
        otherLine = this.getLine(row + 1),
        joined = firstLine + otherLine.replace(/^\s+/, "") + this.document.constructor.newline;
    this.replace({start: {column: 0, row}, end: {column: 0, row: row + 2}}, joined, true);
    return {row, column: firstLine.length};
  }

  get whatsVisible() {
    return this.textLayout.whatsVisible(this);
  }

  flash(range = this.selection.range, options) {
    options = {time: 1000, fill: Color.orange, ...options};
    var id = options.id || "flash" + string.newUUID();
    this.addMarker({
      id,
      range: range,
      style: {
        "background-color": options.fill.toCSSString(),
        "pointer-events": "none"
      }
    });
    fun.debounceNamed("flash-" + id, options.time, () => this.removeMarker(id))();
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // TextAttributes
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  addTextAttribute(attr, range = this.selection) {
    let plainRange = {start: range.start, end: range.end};
    this.undoManager.undoStart(this, "addTextAttribute");
    this.addMethodCallChangeDoing(
      {
        target: this,
        selector: "addTextAttribute",
        args: [attr, plainRange],
        undo: {
          target: this,
          selector: "removeTextAttribute",
          args: [attr, plainRange]
        }
      },
      () => {
        this.document.mixinTextAttribute(attr, plainRange);
        this.onAttributesChanged(plainRange);
        this.consistencyCheck();
      }
    );
    this.undoManager.undoStop();
    return attr;
  }

  removeTextAttribute(attr, range = this.selection) {
    let plainRange = {start: range.start, end: range.end};
    this.undoManager.undoStart(this, "removeTextAttribute");
    this.addMethodCallChangeDoing(
      {
        target: this,
        selector: "removeTextAttribute",
        args: [attr, plainRange],
        undo: {
          target: this,
          selector: "addTextAttribute",
          args: [attr, plainRange]
        }
      },
      () => {
        this.document.mixoutTextAttribute(attr, plainRange);
        this.onAttributesChanged(plainRange);
        this.consistencyCheck();
      }
    );
    this.undoManager.undoStop();
  }

  setTextAttributesWithSortedRanges(textAttributesAndRanges) {
    // textAttributesAndRanges is expected to be a flat list of pairs,
    // first element is a range {start: {row, column}, end: {row, column}} and
    // second element is an attribute:
    // [range1, attr1, range2, attr2, ...]
    // ranges are expected to be sorted and non-overlapping!!!
    // console.log(textAttributesAndRanges)
    this.document.setTextAttributesWithSortedRanges(textAttributesAndRanges);
    this.consistencyCheck();
    let i = 0;
    while (i < textAttributesAndRanges.length) {
       this.onAttributesChanged(textAttributesAndRanges[i])
       i += 2;
    }
    //this.invalidateTextLayout(true, true);
    // FIXME only update affected range!
    // this.onAttributesChanged({start: {row: 0, column: 0}, end: this.documentEndPosition});
  }

  textAttributeAt(textPos) {
    let {document: d, textLayout: tl} = this;
    return d.textAttributeAt(textPos);
  }

  textAttributeAtPoint(point) {
    return this.textAttributeAt(this.textLayout.textPositionFromPoint(this, point));
  }

  textAndAttributesInRange(range = this.selection.range) {
    return this.document.textAndAttributesInRange(range);
  }

  resetTextAttributes() {
    this.document.resetTextAttributes();
    this.onAttributesChanged(this.documentRange);
    this.consistencyCheck();
  }

  onAttributesChanged(range) {
    this.invalidateTextLayout(false, false);
    let tl = this.textLayout;
    if (tl) {
      tl.resetLineCharBoundsCacheOfRange(this, range);
    }
    this.makeDirty();
  }

  styleAt(point) {
    var chunk = this.textLayout.chunkAtPos(this, point);
    return chunk ? chunk.style : {...this.defaultTextStyle};
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // text styles (ranges)
  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  getStyleInRange(range = this.selection) {
    let attrs = this.textAndAttributesInRange(range).filter((ea, i) => i % 2 != 0);
    return attrs.reduce((all, ea) => {
      for (let key in ea) {
        let val = ea[key];
        if (all.hasOwnProperty(key) && (val === undefined || val === null)) continue;
        all[key] = val;
      }
      return all;
    }, {});
  }

  setStyleInRange(attr, range = this.selection) {
    // record the existing attributes for undo...
    let textAndAttributes = this.textAndAttributesInRange(range),
        currentRange = {start: {...range.start}, end: {...range.start}},
        rangesAndAttributes = [];
    for (let i = 0; i < textAndAttributes.length; i = i + 2) {
      let text = textAndAttributes[i], attr = textAndAttributes[i + 1], newlineIndex = -1;
      if (typeof text !== "string") text = objectReplacementChar;
      while ((newlineIndex = text.indexOf("\n")) > -1) {
        if (newlineIndex > 0) {
          currentRange.end.column = currentRange.end.column + newlineIndex;
          rangesAndAttributes.push(currentRange, attr);
        }
        let pos = {row: currentRange.end.row + 1, column: 0};
        currentRange = {start: pos, end: {...pos}};
        text = text.slice(newlineIndex + 1);
      }
      currentRange.end.column += text.length;
      rangesAndAttributes.push(currentRange, attr);
      currentRange = {start: {...currentRange.end}, end: {...currentRange.end}};
    }

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

    this.undoManager.undoStart(this, "setStyleInRange");
    this.addMethodCallChangeDoing(
      {
        target: this,
        selector: "setStyleInRange",
        args: [attr, range],
        undo: {
          target: this,
          selector: "setTextAttributesWithSortedRanges",
          args: [rangesAndAttributes]
        }
      },
      () => {
        this.document.setTextAttribute(attr, range);
        this.consistencyCheck();
        this.onAttributesChanged(range);
      }
    );
    this.undoManager.undoStop();
  }

  resetStyleInRange(range = this.selection) {
    let textAndAttrs = this.document.textAndAttributesInRange(range), mixout = {};
    for (let i = 0; i < textAndAttrs.length; i = i + 2)
      Object.assign(mixout, textAndAttrs[i + 1]);
    this.removeTextAttribute(mixout, range);
  }

  changeStyleProperty(propName, newValueFn, range = this.selection) {
    // gets the property specified by propName. Figures out what the values of
    // those property is in the specified range and gives its value as parameter
    // to newValueFn. The function is then expected to produce a new value for
    // property.
    // Example: text.changeStyleProperty("fontSize", size => size ? size+10 : 20);
    var oldValue = this.getStyleInRange(range)[propName], newValue = newValueFn(oldValue);
    this.selections.forEach(sel => this.addTextAttribute({[propName]: newValue}, sel));
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // selection

  inMultiSelectMode() {
    return this.selection.selections && this.selection.selections.length > 1;
  }

  selectionBounds() {
    return this.selections
      .map(sel => {
        var start = this.charBoundsFromTextPosition(sel.start),
            end = this.charBoundsFromTextPosition(sel.end);
        return sel.start.row === sel.end.row
          ? start.union(end)
          : rect(
              pt(this.padding.left(), start.top()),
              pt(this.width - this.padding.left(), end.bottom())
            );
      })
      .reduce((all, ea) => ea.union(all));
  }

  get documentEndPosition() {
    return this.document ? this.document.endPosition : {row: 0, column: 0};
  }
  isAtDocumentEnd() {
    return eqPosition(this.cursorPosition, this.documentEndPosition);
  }
  get documentRange() {
    return {start: {row: 0, column: 0}, end: this.documentEndPosition};
  }

  cursorUp(n = 1) {
    return this.selection.goUp(n);
  }
  cursorDown(n = 1) {
    return this.selection.goDown(n);
  }
  cursorLeft(n = 1) {
    return this.selection.goLeft(n);
  }
  cursorRight(n = 1) {
    return this.selection.goRight(n);
  }

  getPositionAboveOrBelow(
    n = 1,
    pos = this.cursorPosition,
    useScreenPosition = false,
    goalColumn,
    goalX
  ) {
    // n > 0 above, n < 0 below
    if (n === 0) return pos;

    // raw char bounds are without text padding so subtract it from goalX as well
    if (typeof goalX === "number") goalX -= this.padding.left();

    let nextRow = pos.row, nextCol = pos.column;

    if (!useScreenPosition || !this.lineWrapping) {
      nextRow = Math.min(Math.max(0, pos.row - n), this.lineCount() - 1);
      if (typeof goalX === "number") {
        let charBounds = this.textLayout.charBoundsOfRow(this, nextRow);
        nextCol = columnInCharBoundsClosestToX(charBounds, goalX);
      }
    } else {
      // up / down in screen coordinates is a little difficult, there are a
      // number of requirements to observe:
      // When going up and down "goalX" should be observed, that is
      // the x offset from the (screen!) line start that the cursor should
      // be placed at. If the (screen) line is shorter than that then the cursor
      // should be placed at line end. Important here is that the line end for
      // wrapped lines is actually not the column value after the last char but
      // the column before the last char (b/c there is no newline the cursor could
      // be placed between). For actual line ends the last column value is after
      // the last char.

      let ranges = this.textLayout.rangesOfWrappedLine(this, pos.row);

      if (!ranges.length) return pos;

      var currentRangeIndex =
        ranges.length -
        1 -
        ranges.slice().reverse().findIndex(({start, end}) => start.column <= pos.column),
          currentRange = ranges[currentRangeIndex],
          nextRange,
          nextRangeIsAtLineEnd = false;

      if (n >= 1) {
        var isFirst = 0 === currentRangeIndex;
        nextRange = isFirst
          ? pos.row <= 0
              ? null
              : arr.last(this.textLayout.rangesOfWrappedLine(this, pos.row - 1))
          : ranges[currentRangeIndex - 1];
        if (!nextRange) return pos;
        nextRangeIsAtLineEnd = isFirst;
      } else if (n <= -1) {
        var isLast = ranges.length - 1 === currentRangeIndex,
            nextRanges = isLast
              ? pos.row >= this.lineCount() - 1
                  ? []
                  : this.textLayout.rangesOfWrappedLine(this, pos.row + 1)
              : ranges.slice(currentRangeIndex + 1);
        nextRange = nextRanges[0];
        if (!nextRange) return pos;
        nextRangeIsAtLineEnd = nextRanges.length === 1;
      }

      nextRow = nextRange.start.row;
      let charBounds = this.textLayout
        .charBoundsOfRow(this, nextRow)
        .slice(nextRange.start.column, nextRange.end.column + 1);
      nextCol = nextRange.start.column + columnInCharBoundsClosestToX(charBounds, goalX);
    }

    let newPos = {row: nextRow, column: nextCol};
    return Math.abs(n) > 1
      ? this.getPositionAboveOrBelow(
          n + (n > 1 ? -1 : 1),
          newPos,
          useScreenPosition,
          goalColumn,
          goalX
        )
      : newPos;

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // helper

    function columnInCharBoundsClosestToX(charBounds, goalX) {
      // find the index of the bounds in charBounds whose x offset is nearest to goalX
      charBounds = charBounds.slice();
      charBounds.push({x: arr.last(charBounds).x + arr.last(charBounds).width});
      let closestColumn = 0, distToGoalX = Infinity;
      for (let i = 0; i < charBounds.length; i++) {
        let {x} = charBounds[i], dist = Math.abs(x - goalX);
        if (dist < distToGoalX) {
          distToGoalX = dist;
          closestColumn = i;
        }
      }
      return closestColumn;
    }
  } /*already as wrapped column*/

  collapseSelection() {
    this.selection.collapse(this.selection.lead);
    return this.selection;
  }

  selectAll() {
    this.selection.selectAll();
    return this.selection;
  }

  selectLine(row = this.cursorPosition.row, includingLineEnd = false) {
    this.selection.selectLine(row, includingLineEnd);
    return this.selection;
  }

  selectionOrLineString() {
    var {text, start} = this.selection;
    return text ? text : this.getLine(start.row);
  }

  scrollCursorIntoView() {
    this.scrollPositionIntoView(this.cursorPosition);
  }

  centerRange(range = this.selection.range, offset = pt(0, 0), alignAtTopIfLarger = true) {
    var t = this.charBoundsFromTextPosition(range.start).top(),
        b = this.charBoundsFromTextPosition(range.end).bottom(),
        height = b - t;

    if (height < this.height || alignAtTopIfLarger === false) {
      var centerY = t + height / 2;
      this.scroll = this.scroll.withY(centerY - this.height / 2).addPt(offset);
    } else {
      this.scroll = this.scroll.withY(t).addPt(offset);
    }
  }

  centerRow(row = this.cursorPosition.row, offset = pt(0, 0)) {
    return this.alignRowAtTop(row, offset.addXY(0, -this.height / 2));
  }

  alignRowAtTop(row = this.cursorPosition.row, offset = pt(0, 0)) {
    var charBounds = this.charBoundsFromTextPosition({row, column: 0}),
        pos = charBounds.topLeft().addXY(-this.padding.left(), 0);
    this.scroll = pos.addPt(offset);
  }

  alignRowAtBottom(row = this.cursorPosition.row, offset = pt(0, 0)) {
    let charHeight = this.charBoundsFromTextPosition({row, column: 0}).height;
    this.alignRowAtTop(row, offset.addXY(0, -this.textPageHeight() + charHeight));
  }

  scrollPositionIntoView(pos, offset = pt(0, 0)) {
    if (!this.isClip()) return;

    let {scroll, padding} = this,
        viewBounds = this.innerBounds()
          .translatedBy(scroll)
          .insetByRect(this.padding)
          .insetBy(this.borderWidth),
        charBounds = this.charBoundsFromTextPosition(pos);

    // if no line wrapping is enabled we add a little horizontal offset so
    // that characters at line end are better visible
    if (!this.lineWrapping) charBounds = charBounds.insetByPt(pt(-20, 0));

    // if we are close to the bottom, make sure bottom of char is visible:
    let corner = viewBounds.bottom() - charBounds.bottom() > 20 ? "bottomLeft" : "topLeft",
        delta = charBounds[corner]()
          .subPt(viewBounds.translateForInclusion(charBounds)[corner]())
          .addPt(offset);

    if (delta.x != 0 || delta.y != 0) {
      this.scroll = this.scroll.addPt(delta).addPt(offset);
      if (this.isFocused()) this.ensureKeyInputHelperAtCursor();
    }
  }

  keepPosAtSameScrollOffsetWhile(doFn, pos = this.cursorPosition) {
    // doFn has some effect on the text that might change the scrolled
    // position, like changing the font size. This function ensures that the
    // text position given will be at the same scroll offset after running the doFn
    var {scroll, selection: {lead: pos}} = this,
        offset = this.charBoundsFromTextPosition(pos).y - scroll.y,
        isPromise = false,
        cleanup = () =>
          (this.scroll = this.scroll.withY(this.charBoundsFromTextPosition(pos).y - offset));

    try {
      var result = doFn();
      isPromise = result && result instanceof Promise;
    } finally {
      !isPromise && cleanup();
    }
    if (isPromise) promise.finally(result, cleanup);
    return result;
  }

  saveExcursion(doFn, opts) {
    // run doFn that can change the morph arbitrarily and keep selection /
    // scroll as it was before doFn.
    // if opts = {useAnchors: true} is used then use anchors to mark selection.
    // subsequent text modifications will move anchors around. useful for
    // insertText / deleteText but not helpful when entire textString changes.
    opts = {useAnchors: false, ...opts};
    var sels = this.selection.isMultiSelection
      ? this.selection.selections.map(ea => ea.directedRange)
      : [this.selection],
        anchors = opts.useAnchors
          ? sels.map(({start, end}) => [
              this.addAnchor({...start, id: "save-excursion-" + string.newUUID()}),
              this.addAnchor({...end, id: "save-excursion-" + string.newUUID()})
            ])
          : null,
        isPromise = false,
        cleanup = opts.useAnchors
          ? () => {
              var sels = anchors.map(([{position: start}, {position: end}]) => ({start, end}));
              this.selections = sels;
              anchors.forEach(([a, b]) => {
                this.removeAnchor(a);
                this.removeAnchor(b);
              });
            }
          : () => (this.selections = sels);
    try {
      var result = this.keepPosAtSameScrollOffsetWhile(doFn);
      isPromise = result && result instanceof Promise;
    } finally {
      !isPromise && cleanup();
    }
    if (isPromise) promise.finally(result, cleanup);
    return result;
  }

  alignRow(row, how = "center") {
    // how = "center", "bottom", "top";
    if (!this.isClip()) return;
    var {scroll, padding} = this,
        paddedBounds = this.innerBounds().insetByRect(padding).translatedBy(scroll),
        charBounds = this.charBoundsFromTextPosition({row, column: 0}),
        deltaY = how === "top" || how === "bottom"
          ? paddedBounds[how]() - charBounds[how]()
          : how === "center" ? paddedBounds[how]().y - charBounds[how]().y : 0;
    if (deltaY) this.scroll = this.scroll.addXY(0, -deltaY);
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // text layout related

  fit() {
    let {viewState, fixedWidth, fixedHeight} = this;
    viewState._needsFit = false;
    if ((fixedHeight && fixedWidth) || !this.textLayout /*not init'ed yet*/) return this;
    let textBounds = this.textBounds().outsetByRect(this.padding),
        resize = () => {
            if (!fixedHeight && this.height != textBounds.height) this.height = textBounds.height
            if (!fixedWidth && this.width != textBounds.width) this.width = textBounds.width;
            this.embeddedMorphs.forEach(submorph => {
              let a = this.embeddedMorphMap.get(submorph).anchor;
              a.position = a.position;
            });
          }
    viewState._needsFit = false;
    if (this.document.lines.find(l => l.hasEstimatedExtent)) {
      this.whenRendered().then(resize)
    } else {
      resize();
    }
    
    return this;
  }

  fitIfNeeded() {
    if (this.viewState._needsFit) this.fit();
  }

  get defaultLineHeight() {
    var p = this.padding;
    return p.top() + p.bottom() +
      this.fontMetric.defaultLineHeight({
        fontSize: this.fontSize,
        fontFamily: this.fontFamily
      });
  }

  columnInWrappedLine(textPos) {
    if (!this.lineWrapping) return textPos.column;
    let {start: {column: fromColumn}} = this.screenLineRange(textPos, true);
    return textPos.column - fromColumn;
  }

  textPositionFromPoint(point) {
    // localized Point
    return this.textLayout.textPositionFromPoint(this, point);
  }

  charBoundsFromTextPosition(pos) {
    return this.textLayout.boundsFor(this, pos);
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // rendering

  forceRerender() {
    // expensive!
    this.textLayout.reset();
    this.makeDirty();
  }

  aboutToRender(renderer) {
    super.aboutToRender(renderer);
  }

  applyLayoutIfNeeded() {
    this.fitIfNeeded();
    super.applyLayoutIfNeeded();
  }

  render(renderer) {
    return this.textRenderer.renderMorph(this, renderer);
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // mouse events

  onMouseDown(evt) {
    if (evt.rightMouseButtonPressed()) return;
    this.activeMark && (this.activeMark = null);

    var {position, state: {clickedOnMorph, clickedOnPosition, clickCount}} = evt;

    if (clickedOnMorph !== this) return;

    var maxClicks = 3,
        normedClickCount = (clickCount - 1) % maxClicks + 1,
        clickPos = this.localize(position),
        clickTextPos = this.textPositionFromPoint(clickPos);

    if (
      evt.leftMouseButtonPressed() &&
      !evt.isShiftDown() &&
      !evt.isAltDown() &&
      this.callTextAttributeDoitFromMouseEvent(evt, clickPos)
    ) {
      // evt.stop();
      // return;
    }

    if (!this.selectable) return;

    if (evt.isShiftDown()) {
      this.selection.lead = clickTextPos;
    } else if (evt.isAltDown()) {
      this.selection.addRange(Range.at(clickTextPos));
    } else {
      this.selection.disableMultiSelect();
      if (normedClickCount === 1) {
        if (!evt.isShiftDown()) {
          this.selection = {start: clickTextPos, end: clickTextPos};
        } else this.selection.lead = clickTextPos;
      }
      else if (normedClickCount === 2) this.execCommand("select word", null, 1, evt);
      else if (normedClickCount === 3) this.execCommand("select line", null, 1, evt);
    }
    if (this.isFocused()) this.ensureKeyInputHelperAtCursor();
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // click-doit support
  // FIXME move this to somewhere else?

  evalEnvForDoit(doit/*from attribute.doit*/) {
    let moduleId = `lively://text-doit/${this.id}`;
    lively.modules.module(moduleId); // initialize module
    return {
      context: doit.context || this,
      format: "esm",
      targetModule: moduleId
    }
  }

  callTextAttributeDoitFromMouseEvent(evt, clickPos) {
    let attribute = this.textAttributeAtPoint(clickPos) || [],
        doit = attribute && attribute.doit;

    if (!doit || !doit.code) return false;

    let env = this.evalEnvForDoit(doit),
        mod = lively.modules.module(env.targetModule);
    mod.recorder.evt = evt;
    lively.vm.runEval(doit.code, env)
      .catch(err => this.world().logError(new Error(`Error in text doit: ${err.stack}`)))
      .then(() => (mod.recorder.evt = null));

    return true;
  }

  onMouseMove(evt) {
    if (!evt.leftMouseButtonPressed() || !this.selectable || evt.state.clickedOnMorph !== this)
      return;
    this.selection.lead = this.textPositionFromPoint(this.localize(evt.position));
  }

  selectMatchingBrackets(str, i1) {
    //  Selection caret before is char i1
    //  Returns an array[startIndex, endIndex] if it finds matching brackets
    //  This code matches bracket-like characters, and also
    //  Quote. double-quote and back-tick
    //  '//' - selects from there to end of line
    //  '/*' - selects a JS long comment
    //  begin or end of line - selects the line
    //  begin or end of entire string - selects the whole string

    //  PRELUDE definitions.  See below for start of code
    var rightBrackets = "*)}]>'\"`";
    var leftBrackets = "*({[<'\"`";
    function isWhiteSpace(c) {
      return c === "\t" || c === " ";
    }
    function isAlpha(s) {
      var regEx = /^[a-zA-Z0-9\-]+$/;
      return (s || "").match(regEx);
    }
    function periodWithDigit(c, prev) {
      // return true iff c is a period and prev is a digit
      if (c != ".") return false;
      return "0123456789".indexOf(prev) >= 0;
    }
    function matchBrackets(str, chin, chout, start, dir) {
      // starting at index start, look right (dir = -1) or left (dir = -1)
      // for matching bracket chracters. chin is the open-bracket character
      // that takes us into a deeper level, chout is the close-bracket
      // character that takes us out a level and untimately ends the match
      var i = start;
      var depth = 1;
      while (dir < 0 ? i - 1 >= 0 : i + 1 < str.length) {
        i += dir;
        if (str[i] == chin && chin != chout) depth++;
        if (str[i] == chout) depth--;
        if (depth == 0) return i;
      }
      return i;
    }
    function findLine(str, start, dir, endChar) {
      // start points to a CR or LF (== endChar)
      var i = start;
      while (dir < 0 ? i - 1 >= 0 : i + 1 < str.length) {
        i += dir;
        if (str[i] == endChar) return dir > 0 ? [start, i] : [i + 1, start];
      }
      return dir > 0 ? [start + 1, str.length - 1] : [0, start];
    }
    // selectmatchingBrackets START OF CODE...
    if (!str) return i1;
    if (i1 == 0 || i1 == str.length) {
      return [0, str.length - 1];
    }
    // look left for open backets
    var i2 = i1 - 1;
    if (i1 > 0) {
      if (str[i1 - 1] == "\n" || str[i1 - 1] == "\r") return findLine(str, i1, 1, str[i1 - 1]);
      var i = leftBrackets.indexOf(str[i1 - 1]);
      if (str[i1 - 1] == "*" && (i1 - 2 < 0 || str[i1 - 2] != "/")) i = -1; // spl check for /*
      if (i >= 0) {
        var i2 = matchBrackets(str, leftBrackets[i], rightBrackets[i], i1 - 1, 1);
        return [i1, i2 - 1];
      }
    }
    // look right for close brackets
    if (i1 < str.length) {
      if (str[i1] == "\n" || str[i1] == "\r") return findLine(str, i1, -1, str[i1]);
      var i = rightBrackets.indexOf(str[i1]);
      if (str[i1] == "*" && (i1 + 1 >= str.length || str[i1 + 1] != "/")) i = -1; // spl check for */
      if (i >= 0) {
        i1 = matchBrackets(str, rightBrackets[i], leftBrackets[i], i1, -1);
        return [i1 + 1, i2];
      }
    }
    // is a '//' left of me?
    if (str[i1 - 1] === "/" && str[i1 - 2] === "/") {
      while (i2 + 1 < str.length && str[i2 + 1] !== "\n" && str[i2 + 1] !== "\r") {
        i2++;
      }
      return [i1, i2];
    }
    // inside of whitespaces?
    var myI1 = i1;
    var myI2 = i2;
    while (myI1 - 1 >= 0 && isWhiteSpace(str[myI1 - 1]))
      myI1--;
    while (myI2 < str.length && isWhiteSpace(str[myI2 + 1]))
      myI2++;
    if (myI2 - myI1 >= 1) return [myI1, myI2];

    var prev = i1 < str.length ? str[i1] : "";
    while (i1 - 1 >= 0 && (isAlpha(str[i1 - 1]) || periodWithDigit(str[i1 - 1], prev))) {
      prev = str[i1 - 1];
      i1--;
    }
    while (i2 + 1 < str.length && (isAlpha(str[i2 + 1]) || periodWithDigit(str[i2 + 1], prev))) {
      prev = str[i2 + 1];
      i2++;
    }
    return [i1, i2];
  }

  onContextMenu(evt) {
    if (evt.targetMorph !== this) return;
    evt.stop();

    var posClicked = this.textPositionFromPoint(this.localize(evt.position)),
        sels = this.selection.selections || [this.selection];
    if (this.selection.isEmpty() || sels.every(sel => !sel.range.containsPosition(posClicked)))
      this.cursorPosition = posClicked;

    Promise
      .resolve(this.menuItemsForContextMenu()).then(items => this.openMenu(items, evt))
      .catch(err => $world.logError(err));
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  onDrop(evt) {
    let morphs = evt.hand.grabbedMorphs.filter(ea => ea.isLayoutable);
    super.onDrop(evt);
    if (morphs[0]) {
      let textPos = this.textPositionFromPoint(this.localize(evt.hand.globalPosition));
      this.insertText([morphs[0], null], textPos);
      morphs[0].opacity = evt.state.originalOpacity || 1;
    }
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // drop preview:
  // Indicate where the grabbed morph would end up when dropped.
  // 1. Build a "drop grid" on hover to indicate the char positions the morph
  // could be dropped into
  // 2. When the grabbed morph hovers over the text, create a placeholder of it
  // and insert it into the text
  //
  // state tracking:
  // state.dropHover: WeakMap(Text morph => dropHoverCache (text specific state))
  // dropHoverCache.dropGrid
  // dropHoverCache.placeholder

  buildDropHoverGrid(dropConfig) {
    if (dropConfig.simpleDrop) return null;

    let {startRow, endRow} = this.whatsVisible,
        realEndRow = Math.min(this.documentEndPosition.row, endRow),
        doc = this.document,
        padLeft = this.padding.left(),
        padTop = this.padding.top();

    let grid = arr.range(startRow, realEndRow).reduce((bounds, row) => {
      let charBounds = this.textLayout.charBoundsOfRow(this, row).slice();
      if (charBounds.length >= 1 && arr.last(charBounds).width == 0)
        arr.last(charBounds).width = 12;
      if (charBounds.length > 1) {
        let last = arr.last(charBounds);
        charBounds.push({
          x: last.x + last.width,
          y: last.y,
          height: last.height,
          width: last.width || 12
        });
      }
      let rowBounds = charBounds.map((ea, column) => {
        let bounds = Rectangle.fromLiteral(ea).translatedBy(
          pt(padLeft, padTop + doc.computeVerticalOffsetOf(row))
        ),
            globalBounds = this.getGlobalTransform().transformRectToRect(bounds);
        return {
          textPos: {row, column},
          bounds,
          globalBounds,
          morph: dropConfig.showDropGrid
            ? morph({
                reactsToPointer: false,
                acceptsDrops: false,
                bounds: bounds,
                border: {width: 1, color: Color.green},
                fill: null
              })
            : null
        };
      });
      return bounds.concat(rowBounds);
    }, []);

    grid.forEach(ea => ea.morph && this.addMorph(ea.morph));

    return grid;
  }

  onDropHoverIn(evt) {
    let dropConfig = {
      simpleDrop: window.hasOwnProperty("simpleDrop") ? window.simpleDrop : true,
      showDropGrid: window.hasOwnProperty("showDropGrid") ? window.showDropGrid : false,
      useTextFlowPlaceholder: window.hasOwnProperty("useTextFlowPlaceholder")
        ? window.useTextFlowPlaceholder
        : false
    };

    let grabbed = evt.hand.grabbedMorphs[0];
    if (grabbed) { 
      evt.state.originalOpacity = grabbed.opacity;
      grabbed.opacity = .3;
    }

    // build a "drop grid" of the visible lines

    let dropGrid = this.buildDropHoverGrid(dropConfig),
        dropHoverCache = evt.state.dropHover || (evt.state.dropHover = new WeakMap()),
        dropHoverState = dropHoverCache.get(this);
    if (!dropHoverState) {
      dropHoverState = {};
      dropHoverCache.set(this, dropHoverState);
    }
    dropHoverState.config = dropConfig;
    dropHoverState.dropGrid = dropGrid;
  }

  onDropHoverUpdate(evt) {
    let grabbed = evt.hand.grabbedMorphs[0];
    if (!grabbed) return;
    let dropHoverCache = evt.state.dropHover;
    if (!dropHoverCache) return;
    let dropHoverState = dropHoverCache.get(this);
    if (!dropHoverState) return;

    if (!dropHoverState.dropGrid) {
      let textPos = this.textPositionFromPoint(evt.positionIn(this));

      this.focus();
      this.cursorPosition = textPos;
      // let immediateDropAt = this.charBoundsFromTextPosition(textPos).topLeft();
      // let grabbedPos = this.transformToMorph(evt.hand).transformPoint(immediateDropAt);
      // grabbed.position = grabbedPos

      return;
    }

    let config = dropHoverState.config;

    let pos = evt.positionIn(this), dropAt, minSpec, minDist = Infinity;
    for (let dropSpec of dropHoverState.dropGrid) {
      if (dropSpec.bounds.containsPoint(pos)) {
        dropAt = dropSpec;
        break;
      }
      let dist = dropSpec.bounds.closestPointToPt(pos).dist(pos);
      if (dist < minDist) {
        minDist = dist;
        minSpec = dropSpec;
      }
    }
    if (!dropAt) dropAt = minSpec;

    if (!dropAt) return;
    let placeholder = dropHoverState.placeholder;
    if (!placeholder)
      dropHoverState.placeholder = placeholder = morph({
        fill: grabbed.fill,
        extent: grabbed.extent,
        reactsToPointer: false,
        acceptsDrops: false
      });
    if (obj.equals(placeholder._textPos || {}, dropAt.textPos)) return;
    if (this !== placeholder.owner) {
      this.addMorph(placeholder);
    }
    placeholder.position = dropAt.bounds.topLeft();

    if (config && config.useTextFlowPlaceholder) {
      placeholder.remove();
      placeholder._textPos = dropAt.textPos;
      this.insertText([placeholder, null], dropAt.textPos);
    }
  }

  onDropHoverOut(evt) {
    let grabbed = evt.hand.grabbedMorphs[0];
    if (grabbed) {
      grabbed.opacity = evt.state.originalOpacity || 1;
    }

    let dropHoverCache = evt.state.dropHover;
    if (!dropHoverCache) return;
    let dropHoverState = dropHoverCache.get(this);
    if (!dropHoverState) return;
    dropHoverCache.delete(this);
    if (dropHoverState.dropGrid) {
      dropHoverState.dropGrid.forEach(ea => ea.morph && ea.morph.remove());
      dropHoverState.dropGrid = null;
    }
    if (dropHoverState.placeholder) {
      dropHoverState.placeholder.remove();
      dropHoverState.placeholder = null;
    }
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

  async menuItems() {
    let [items1, items2] = await Promise.all([super.menuItems(), this.menuItemsForContextMenu()]);
    return items1.concat({isDivider: true}).concat(items2);
  }

  async menuItemsForContextMenu() {
    var items = [
      {command: "text undo", alias: "undo", target: this, showKeyShortcuts: true},
      {command: "text redo", alias: "redo", target: this, showKeyShortcuts: true},
      {
        command: "manual clipboard copy",
        alias: "copy",
        target: this,
        showKeyShortcuts: this.keysForCommand("clipboard copy"),
        args: {collapseSelection: false, delete: false}
      },
      {
        command: "manual clipboard paste",
        alias: "paste",
        target: this,
        showKeyShortcuts: this.keysForCommand("clipboard paste")
      },
      {
        command: "open text attribute controls",
        alias: "edit text attributes",
        target: this
      },
      {isDivider: true},
      {
        command: "toggle line wrapping",
        alias: (this.lineWrapping ? "disable" : "enable") + " line wrapping",
        target: this,
        showKeyShortcuts: true
      },
      [
        "run command",
        () => {
          this.focus();
          this.world().execCommand("run command");
        }
      ]
    ];

    for (let plugin of this.plugins) {
      if (typeof plugin["getMenuItems"] === "function")
        items = await plugin["getMenuItems"](items);
    }

    return items;
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // keyboard events

  get keybindings() {
    const world = this.world();
    const userKeybindings = (world && world.getCurrentUser() && world.getCurrentUser().config && world.getCurrentUser().config.textKeyBindings)  || [];
    const keybindings = super.keybindings.concat(userKeybindings).concat(config.text.defaultKeyBindings)
    return this.pluginCollect("getKeyBindings", keybindings);
  }
  set keybindings(x) {
    super.keybindings = x;
  }

  get keyhandlers() {
    if (this._cachedKeyhandlers) return this._cachedKeyhandlers;
    let handlers = super.keyhandlers.concat(this._keyhandlers || []);
    handlers = this.pluginCollect("getKeyHandlers", handlers);
    return (this._cachedKeyhandlers = handlers);
  }

  get snippets() {
    return this.pluginCollect("getSnippets", []);
  }
  
  onHoverIn(evt) {
    this.scrollActive = true;
    this.makeDirty();
  }

  onHoverOut(evt) {
    this.scrollActive = false;
    this.makeDirty();
  }

  onKeyDown(evt) {
    if (this.compositionRange || evt.targetMorph != this) return;
    this.selection.cursorBlinkStart();
    KeyHandler.invokeKeyHandlers(this, evt, true /*no input evts*/);
  }

  onTextInput(evt) {
    KeyHandler.invokeKeyHandlers(this, evt, false /*allow input evts*/);
  }

  onCompositionStart(evt) {
　　 this.insertTextAndSelect(evt.data);
    this.compositionRange = this.selection.range;
  }

  onCompositionUpdate(evt) {
    this.selection.range = this.compositionRange;
    this.selection.text = [evt.data, {textDecoration: 'underline'}];
    this.compositionRange = this.selection.range;
  }

  onCompositionEnd(evt) {
    this.selection.range = this.compositionRange;
    this.selection.text = evt.data;
    this.cursorPosition = this.compositionRange.end;
    this.compositionRange = null;
  }

  onCut(evt) {
    if (this.rejectsInput() || !this.isFocused()) return;
    if (config.emacs) return;
    this.onCopy(evt, !this.rejectsInput());
  }

  onCopy(evt, deleteCopiedText = false) {
    if (!this.isFocused()) return;
    evt.stop();
    var sel = this.selection;

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // copy as html
    if (true || !this.editorPlugin) { // WIP
      try {
        let textAndAttributes = this.textAndAttributesInRange(this.selection.range),
            defaultTextStyle = this.defaultTextStyle,
            copyMap = {};
        for (let i = 0; i < textAndAttributes.length; i= i+2) {
          let content = textAndAttributes[i];
          if (!content.isMorph) continue;
          if (content.isDisplacementMorph) {
            textAndAttributes[i] = '';
            continue;
          }
          let snap = copyMap[i] = serializeMorph(textAndAttributes[i]);
          textAndAttributes[i] = deserializeMorph(snap, {reinitializeIds: true});
        }

        let html = extractHTMLFromTextMorph(this, textAndAttributes);
        evt.domEvt.clipboardData.setData("text/html", html);

        for (let i in copyMap) textAndAttributes[i] = copyMap[i];
        let data = JSON.stringify({textAndAttributes, defaultTextStyle});
        evt.domEvt.clipboardData.setData("application/x-lively-text", data);
      } catch (err) { $world.logError(err); }
    }

    // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
    // copy as text
    evt.domEvt.clipboardData.setData("text/plain", sel.text);

    this.execCommand("manual clipboard copy", {
      collapseSelection: config.codeEditor.collapseSelection || false,
      delete: deleteCopiedText,
      dontTryNativeClipboard: true
    });
  }

  onPaste(evt) {
    if (this.rejectsInput()) return;
    evt.stop();

    // read clipboard
    var lvData, textData = "";

    try {
      textData = evt.domEvt.clipboardData.getData("text");
    } catch (err) { console.warn(err); }

    if (!this.editorPlugin) { // "rich text" paste
      try {
        var raw = evt.domEvt.clipboardData.getData("application/x-lively-text");
        lvData = raw && JSON.parse(raw);
        var attrs = lvData.textAndAttributes;
        for (let i = 0; i < attrs.length; i = i+2) {
          if (typeof attrs[i] === "string") continue;
          attrs[i] = deserializeMorph(attrs[i], {reinitializeIds: true});
        }
      } catch (err) { console.warn(err); }
    }

    let sel = this.selection,
        sels = sel.isMultiSelection ? sel.selections : [sel];

    lvData && this.undoManager.group();

    sels.forEach(sel => {
      if (lvData) this.replace(sel.range, lvData.textAndAttributes, false, true, true)
      else sel.text = textData;
      this.saveMark(sel.start);
      sel.collapseToEnd();
    });
    lvData && this.undoManager.group();
  }

  onFocus(evt) {
    super.onFocus(evt);
    this.makeDirty();
    this.selection.cursorBlinkStart();
    if (this._originalShadow) return;
    this._originalShadow = this.dropShadow;
    this.highlightWhenFocused && this.animate({
      dropShadow: this.haloShadow || this.propertiesAndPropertySettings().properties.haloShadow.defaultValue,
      duration: 200
    });
  }

  onBlur(evt) {
    this.makeDirty();
    this.selection.cursorBlinkStop();
    this.highlightWhenFocused && this.animate({
      dropShadow: this._originalShadow || null,
      duration: 200
    });
    this._originalShadow = null;
    super.onBlur(evt);
  }
  
  onScroll(evt) {
    if (this.isFocused()) this.ensureKeyInputHelperAtCursor();
    // FIXME rk 2017-07-25: quick hack to make text map work
    {
      let node = this.env.renderer.getNodeForMorph(this);
      if (node) {
        let {scrollTop, scrollLeft} = node;
        signal(this, "viewChanged", {prop: "scroll", value: pt(scrollLeft, scrollTop)})
      }

    }
  }

  ensureKeyInputHelperAtCursor() {
    // move the textarea to the text cursor
    if (this.env.eventDispatcher.keyInputHelper)
      this.env.eventDispatcher.keyInputHelper.ensureBeingAtCursorOfText(this);
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // command helper

  textPageHeight() {
    let {height, padding, borderWidthBottom, borderWidthTop} = this;
    return height - padding.top() - padding.bottom() - borderWidthBottom - borderWidthTop;
  }
  scrollPageDown() {
    this.scrollDown(this.textPageHeight());
  }
  scrollPageUp() {
    this.scrollUp(this.textPageHeight());
  }

  pageUpOrDown(opts = {direction: "up", select: false}) {
    // opts = {direction: "up", select: false}
    // opts = {direction: "down", select: false}
    let {direction, select} = opts,
        row = this.textLayout[
          direction === "down" ? "lastFullVisibleLine" : "firstFullVisibleLine"
        ](this),
        {cursorPosition: {column}, padding} = this;
    if (!select) this.cursorPosition = {row, column};
    else this.selection.lead = {row, column};
    if (direction === "down") {
      this.alignRowAtTop(row, pt(0, -padding.top() - padding.bottom()));
    } else {
      this.alignRowAtBottom(row, pt(0, 0));
      this.alignRowAtBottom(row, pt(0, padding.top() + padding.bottom()));
    }
  }

  gotoDocumentStart(opts = {select: false}) {
    this.selection.lead = {row: 0, column: 0};
    if (!opts || !opts.select) this.selection.anchor = this.selection.lead;
  }

  gotoDocumentEnd(opts = {select: false}) {
    this.selection.lead = this.documentEndPosition;
    if (!opts || !opts.select) this.selection.anchor = this.selection.lead;
  }

  paragraphRangeAbove(row) {
    var startLineIsEmpty = this.isLineEmpty(row), rowInParagraph;
    if (startLineIsEmpty) {
      // we need to go above to find the paragraph start
      for (var i = row - 1; i >= 0; i--)
        if (!this.isLineEmpty(i)) {
          rowInParagraph = i;
          break;
        }
      if (rowInParagraph === undefined) return {start: {row, column: 0}, end: {row, column: 0}};
    } else rowInParagraph = row;
    return this.paragraphRange(rowInParagraph);
  }

  paragraphRangeBelow(row) {
    var startLineIsEmpty = this.isLineEmpty(row),
        rowInParagraph,
        endPos = this.documentEndPosition;

    if (startLineIsEmpty) {
      // we need to go above to find the paragraph start
      for (var i = row + 1; i <= endPos.row; i++)
        if (!this.isLineEmpty(i)) {
          rowInParagraph = i;
          break;
        }
      if (rowInParagraph === undefined) return {start: {row, column: 0}, end: {row, column: 0}};
    } else rowInParagraph = row;

    return this.paragraphRange(rowInParagraph);
  }

  paragraphRange(row) {
    if (this.isLineEmpty(row)) return {start: {row, column: 0}, end: {row, column: 0}};

    var endPos = this.documentEndPosition, pragraphEnd;

    for (var i = row + 1; i <= endPos.row; i++)
      if (this.isLineEmpty(i)) {
        pragraphEnd = {row: i - 1, column: this.getLine(i - 1).length};
        break;
      }
    if (!pragraphEnd) pragraphEnd = endPos;

    var start;
    for (var i = pragraphEnd.row - 1; i >= 0; i--)
      if (this.isLineEmpty(i)) {
        start = {row: i + 1, column: 0};
        break;
      }
    if (!start) start = {row: 0, column: 0};

    return {start, end: pragraphEnd};
  }

  astNodeRange(node) {
    // node is expected to be in mozilla AST format, ie {type, start: INDEX, end: INDEX}
    return {
      start: this.document.indexToPosition(node.start),
      end: this.document.indexToPosition(node.end)
    };
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // text undo / redo

  parseIntoLines(text) {
    return text.split("\n");
  }

  computeTextRangeForChanges(changes) {
    let defaultRange = Range.at(this.cursorPosition);
    if (!changes.length) return defaultRange;

    var morph = this,
        change = changes[0],
        range = change.selector === "replace"
          ? insertRange(change.args[1], change.args[0].start)
          : defaultRange;

    for (let i = 1; i < changes.length; i++) {
      let change = changes[i];
      range = change.selector === "replace"
        ? range.merge(insertRange(change.args[1], change.args[0].start))
        : range;
    }

    return range;

    function insertRange(textAndAttributes, pos) {
      let text = "";
      for (let i = 0; i < textAndAttributes.length; i = i + 2)
        text += typeof textAndAttributes[i] === "string"
          ? textAndAttributes[i]
          : objectReplacementChar;

      let lines = morph.parseIntoLines(text), range;

      if (lines.length === 1)
        return Range.fromPositions(pos, {row: pos.row, column: pos.column + lines[0].length});

      if (lines.length > 1)
        return Range.fromPositions(pos, {
          row: pos.row + lines.length - 1,
          column: arr.last(lines).length
        });

      return Range.at(pos);
    }
  }

  ensureUndoManager() {
    if (this.undoManager) return this.undoManager;
    let selectors = ["addTextAttribute", "removeTextAttribute", "setStyleInRange", "replace"];
    return (this.undoManager = new UndoManager(change => selectors.includes(change.selector)));
  }

  textUndo() {
    var undo = this.undoManager.undo();
    if (!undo) return; // no undo left
    var changes = undo.changes.slice().reverse().map(ea => ea.undo);
    this.selection = this.computeTextRangeForChanges(changes);
  }

  textRedo() {
    var redo = this.undoManager.redo();
    if (!redo) return; // nothing to redo
    var changes = redo.changes.slice();
    this.selection = this.computeTextRangeForChanges(changes);
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // search

  findMatchingForward(pos, side = "right", pairs = {}) {
    // searching for closing char, counting open and closing
    // side is the char we want to match "right" or "left" of pos?
    // pairs can be a JS object like {"[": "]", "<": ">"}
    var openChar = this[side === "right" ? "charRight" : "charLeft"](pos),
        closeChar = pairs[openChar];
    if (!closeChar) return null;

    var counter = side === "right" ? -1 : 0;
    return this.document.scanForward(pos, (char, pos) => {
      if (char === closeChar) {
        if (counter === 0)
          return side === "right" ? {row: pos.row, column: pos.column + 1} : pos;
        else counter--;
      } else if (char === openChar) counter++;
      return null;
    });
  }

  findMatchingBackward(pos, side = "right", pairs = {}) {
    // see findMatchingForward
    var openChar = this[side === "right" ? "charRight" : "charLeft"](pos),
        closeChar = pairs[openChar];
    if (!closeChar) return null;

    var counter = side === "left" ? -1 : 0;
    return this.document.scanBackward(pos, (char, pos) => {
      if (char === closeChar) {
        if (counter === 0)
          return side === "right" ? {row: pos.row, column: pos.column + 1} : pos;
        else counter--;
      } else if (char === openChar) counter++;
      return null;
    });
  }

  search(
    needle,
    options = {start: this.cursorPosition, backwards: false, caseSensitive: false}
  ) {
    return new TextSearcher(this).search({needle, ...options});
  }

  searchForAll(needle, options = {caseSensitive: false}) {
    return new TextSearcher(this).searchForAll({needle, ...options});
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // editor support

  tokenAt(pos) {
    return this.pluginInvokeFirst("tokenAt", pos);
  }
  astAt(pos) {
    return this.pluginInvokeFirst("astAt", pos);
  }
  get evalEnvironment() {
    var p = this.editorPlugin;
    return p && p.evalEnvironment;
  }
  set evalEnvironment(env) {
    var p = this.editorPlugin;
    p && (p.evalEnvironment = env);
  }
  get doitContext() {
    var {context} = this.evalEnvironment || {};
    return context;
  }
  set doitContext(c) {
    (this.evalEnvironment || {}).context = c;
  }

  logDoit(source, opts = {}) {
    let {time = Date.now()} = opts,
        maxLogLength = 50,
        maxCodeLength = 120000,
        log;
    if (source.length > maxCodeLength) return;
    try { log = JSON.parse(localStorage["lively.next-js-ide-doitlog"]); } catch (err) {}
    if (!log) log = [];
    if (log.some(ea => typeof ea === "string" ? ea === source : ea.source === source)) return;
    log.push({source, time});
    if (log.length > maxLogLength) log = log.slice(-maxLogLength);
    try { localStorage["lively.next-js-ide-doitlog"] = JSON.stringify(log); } catch (err) {}
  }

  doEval(
   range = this.selection.isEmpty() ? this.lineRange() : this.selection.range,
   additionalOpts,
   code = this.textInRange(range)
  ) {
    var plugin = this.pluginFind(p => p.isEditorPlugin && typeof p.runEval === "function");
    if (!plugin)
      throw new Error(`doit not possible: cannot find js editor plugin of !${this}`);
    if (additionalOpts && additionalOpts.logDoit) {
      this.logDoit(code, additionalOpts);
    }
    return plugin.runEval(code, additionalOpts);
  }

  maybeSelectCommentOrLine() {
    // Dan's famous selection behvior! Here it goes...
    /*   If you click to the right of '//' in the following...
    'wrong' // 'try this'.slice(4)  //should print 'this'
    'http://zork'.slice(7)          //should print 'zork'
    */
    // If click is in comment, just select that part
    var sel = this.selection,
        {row, column} = sel.lead,
        text = this.selectionOrLineString();

    if (!sel.isEmpty()) return;

    // text now equals the text of the current line, now look for JS comment
    var idx = text.indexOf('//');
    if (idx === -1                          // Didn't find '//' comment
        || column < idx                 // the click was before the comment
        || (idx>0 && (':"'+"'").indexOf(text[idx-1]) >=0)    // weird cases
       ) { this.selectLine(row); return }

    // Select and return the text between the comment slashes and end of method
    sel.range = {start: {row, column: idx + 2}, end: {row, column: text.length}};
  }

  // -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
  // debugging

  debugHelper(opts) {
    opts = {
      debugDocumentUpdate: true,
      debugTextLayout: true,
      ...opts
    };

    if (this._debugHelper) return Object.assign(this._debugHelper, opts);

    return (this._debugHelper = {
      ...opts,
      logged: [],
      groups: [],
      reset() {
        this.groups = [[]];
        this.logged = this.groups[0];
      },

      log(...args) {
        console.log(...args);
        this.logged.push({args});
      },

      dump(dump) {
        console.log(dump.split("\n").map(ea => ea.slice(0, 100)).join("\n"));
        this.logged.push({dump});
      },

      group(title) {
        this.groups.push([]);
        this.logged = arr.last(this.groups);
        console.group(title);
      },

      groupEnd(title) {
        console.groupEnd(title);
      },

      steps(logged) {
        let steps = [];
        while (logged.length) {
          let actions = arr.takeWhile(logged, ea => !ea.dump);
          logged = logged.slice(actions.length);
          let {dump} = logged.shift() || {};
          steps.push({
            actions,
            dump
          });
        }
        return steps;
      },

      printToConsole() {
        console.clear();
        this.groups.forEach(group => {
          let steps = this.steps(group);
          console.group(steps.length);
          this.steps(group).forEach(({actions}, i) => {
            console.group(`step ${i + 1}`);
            actions.forEach(({args}) => console.log(...args));
            console.groupEnd(`step ${i + 1}`);
          });
          console.groupEnd(steps.length);
        });
      },

      async report() {
        let jsDiff = await System.import("jsdiff", System.decanonicalize("lively.morphic")),
            {default: DiffEditorPlugin} = await System.import("lively.ide/diff/editor-plugin.js"),
            indent = 0,
            report = "", reportStyles = [], row = 0;

        this.groups.forEach((group, groupN) => {
          report += `>>> group ${groupN + 1}\n`;
          row++;
          indent++;
          let steps = this.steps(group);
          steps.forEach(({actions, dump}, i) => {
            report += string.indent(`>>> step ${i + 1}`, " ", indent) + "\n";
            row++;
            indent++;
            actions.forEach(({args}) => {
              let content = string.indent(
                string.formatFromArray(args.slice()).trim(),
                " ",
                indent
              );
              row += content.split("\n").length;
              report += content + "\n";
            });
            if (i >= 1 && dump && steps[i - 1].dump) {
              let p = new DiffEditorPlugin();
              let patch = jsDiff.createPatch(String(i), steps[i - 1].dump, dump);
              p.tokenize(patch);
              reportStyles.push(...p.styledRanges(row, indent));
              report += patch;
              row += patch.split("\n").length - 1;
            }
            report += string.indent(`<< step ${i + 1}`, " ", indent) + "\n";
            row++;
            indent--;
          });
          report += `<<< group ${groupN + 1}\n`;
          row++;
          indent--;
        });
        return {report, reportStyles};
      },

      async openReport() {
        let {reportStyles, report} = await this.report();
        return $world.execCommand("open text window", {
          title: "text debug",
          fontFamily: "monospace",
          content: report,
          rangesAndStyles: reportStyles
        });
      }
    });
  }

  consistencyCheck() {
    // don't fix in debug mode
    if (this.debug) return this.document.consistencyCheck();
    try {
      return this.document.consistencyCheck();
    } catch (err) {
      // Keep doc around for debugging
      let brokenDocument = this.document;
      if (!this.brokenDocument) this.brokenDocument = brokenDocument;
      let world = this.world() || $world;
      try {
        // try to fix things by at last keeping the content
        let fixedDoc = new Document([]);
        fixedDoc.textAndAttributes = brokenDocument.textAndAttributes;
        this.changeDocument(fixedDoc);
      } catch (err) {
        let msg = `Broken document could not be fixed`;
        world ? world.logError(msg) : console.error(msg);
      }
      // report
      world ? world.logError(err) : console.error(err);
    }
  }

}
