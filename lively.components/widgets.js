import { obj, string, num, arr, properties } from "lively.lang";
import { pt, Color, Rectangle, rect } from "lively.graphics";
import { signal, connect, disconnect } from "lively.bindings";
import {
  Morph,
  morph,
  Text,
  GridLayout,
  HorizontalLayout,
  StyleSheet,
  Path,
  Ellipse,
  Label,
  Tooltip,
  Icon
} from "lively.morphic";

import { Shapes, Intersection } from 'kld-intersections';


class LeashEndpoint extends Ellipse {

  get dragTriggerDistance() { return this.connectedMorph ? 20 : 0; }

  onDragStart(evt) {
    let {lastDragPosition, clickedOnPosition} = evt.state;
    evt.state.dragDelta = lastDragPosition.subPt(clickedOnPosition);
    evt.state.endpoint = this;
    this.leash.onEndpointDrag(evt);
  }

  canConnectTo(m) {
    return !m.isWorld && !m.isHaloItem && this.leash.canConnectTo(m)
            && !m.isHighlighter && !m.ownerChain().some(m => m.isHaloItem);
  }

  onDrag(evt) {
    if (this.connectedMorph) {
      this.clearConnection();
    } else {
      var m = evt.hand.findDropTarget(
        evt.hand.position,
        [this.leash, this.leash.endPoint, this.leash.startPoint],
        m => this.canConnectTo(m)
      );
      if (this.possibleTarget != m && this.highlighter) this.highlighter.deactivate();
      this.possibleTarget = m;
      if (this.possibleTarget) {
        this.closestSide = this.possibleTarget
          .globalBounds()
          .partNameNearest(obj.keys(Leash.connectionPoints), this.globalPosition);
        this.highlighter = $world.highlightMorph($world, this.possibleTarget, false, [this.closestSide]);
        this.highlighter.show();
      }
    }
    evt.state.endpoint = this;
    this.leash.onEndpointDrag(evt);
  }

  onDragEnd() {
    $world.removeHighlighters();
    if (this.possibleTarget && this.closestSide) {
      this.attachTo(this.possibleTarget, this.closestSide);
    }
  }
  
  getConnectionPoint() {
    const {isPath, isPolygon, vertices, origin} = this.connectedMorph,
          gb = this.connectedMorph.globalBounds();
    if ((isPath || isPolygon) && this.attachedSide != "center") {
      const vs = vertices.map(({x, y}) => pt(x, y).addPt(origin)),
            ib = Rectangle.unionPts(vs),
            side = ib[this.attachedSide](),
            center = ib.center().addPt(ib.center().subPt(side)),
            line = Shapes.line(side.x, side.y, center.x, center.y),
            path = Shapes.polyline(arr.flatten(vs.map(({x, y}) => [x,y]))),
            {x, y} = arr.min(Intersection.intersect(path, line).points, ({x, y}) => pt(x, y).dist(side));
      return pt(x, y).addPt(gb.topLeft());
    } else {
      return gb[this.attachedSide]();
    }
  }

  update(change) {
    if (change
        && !["position", "extent", "rotation", "scale"].includes(change.prop)
        && change.target != this.connectedMorph) return;
    if (!this.connectedMorph) return;
    const globalPos = this.getConnectionPoint(), pos = this.leash.localize(globalPos);
    this.vertex.position = pos;
    this.relayout();
  }

  clearConnection() {
    if (this.connectedMorph) {
      disconnect(this.connectedMorph, 'onChange', this, 'update');
      this.connectedMorph = null;
    }
  }

  relayout(change) {
    const {x, y} = this.vertex.position, bw = this.leash.borderWidth;
    if (change && change.meta && change.meta.animation) {
      this.animate({center: pt(x + bw, y + bw), duration: change.duration});
    } else {
      this.center = pt(x + bw, y + bw);
    }
  }

  attachTo(morph, side) {
    this.clearConnection();
    this.leash.openInWorld(this.leash.position);
    this.connectedMorph = morph;
    this.attachedSide = side;
    this.vertex.controlPoints = this.leash.controlPointsFor(side, this);
    this.update();
    connect(this.connectedMorph, 'onChange', this, "update");
  }

  static get properties() {
    return {
      index: {},
      leash: {},
      nativeCursor: {defaultValue: '-webkit-grab'},
      attachedSide: {},
      connectedMorph: {},
      vertex: {
        after: ['leash'],
        get() {
          return this.leash.vertices[this.index];
        },
        set(v) {
          this.leash.vertices[this.index] = v;
          this.leash.vertices = this.leash.vertices; // this is a very akward interface
        }
      }
    };
  }
}

export class Leash extends Path {

  static get connectionPoints() {
    return {
      topCenter: pt(0, -1),
      topLeft: pt(-1, -1),
      rightCenter: pt(1, 0),
      bottomRight: pt(1, 1),
      bottomCenter: pt(0, 1),
      bottomLeft: pt(-1, 1),
      leftCenter: pt(-1, 0),
      topRight: pt(1, -1),
      center: pt(0, 0)
    };
  }

  static get properties() {
    return {
      start: {defaultValue: pt(0,0)}, end: {defaultValue: pt(0,0)},
      canConnectTo: {defaultValue: m => true},
      reactsToPointer: {defaultValue: false},
      wantsDroppedMorphs: {defaultValue: false},
      direction: {
        type: 'Enum',
        values: ['unidirectional', 'outward', 'inward'],
        defaultValue: 'unidirectional'
      },
      endpointStyle: {
        isStyleProp: true,
        defaultValue: {
          fill: Color.black,
          origin: pt(3.5, 3.5),
          extent: pt(10, 10),
          nativeCursor: "-webkit-grab"
        }
      },
      borderWidth: {defaultValue: 2},
      borderColor: {defaultValue: Color.black},
      fill: {defaultValue: Color.transparent},
      vertices: {
        after: ["start", "end"],
        initialize() {
          this.vertices = [this.start, this.end];
        }
      },
      submorphs: {
        initialize() {
          this.submorphs = [
            (this.startPoint = this.endpoint(0)),
            (this.endPoint = this.endpoint(1))
          ];
          connect(this, "onChange", this, "relayout");
          this.updateEndpointStyles();
        }
      }
    };
  }

  onMouseDown(evt) {
    this.updateEndpointStyles();
  }

  updateEndpointStyles() {
    Object.assign(this.startPoint, this.getEndpointStyle(0));
    Object.assign(this.endPoint, this.getEndpointStyle(1));
    this.relayout();
  }

  remove() {
    super.remove();
    this.startPoint.clearConnection();
    this.endPoint.clearConnection();
  }

  onEndpointDrag(evt) {
    const pos = evt.state.endpoint.vertex.position;
    evt.state.endpoint.vertex.position = pos.addPt(evt.state.dragDelta);
    this.relayout();
  }

  getEndpointStyle(idx) {
    return {
      ...this.endpointStyle,
      ...(idx == 0 ? this.endpointStyle.start : this.endpointStyle.end)
    };
  }

  endpoint(idx) {
    const leash = this, {x, y} = leash.vertices[idx];
    return new LeashEndpoint({index: idx, leash: this, position: pt(x, y)});
  }

  controlPointsFor(side, endpoint) {
    var next = Leash.connectionPoints[side];
    next = (endpoint == this.startPoint ? next.negated() : next);
    return {previous: next.scaleBy(100), next: next.negated().scaleBy(100)};
  }

  relayout(change) {
    if (change && !['vertices', 'position'].includes(change.prop)) return;
    this.startPoint.relayout(change);
    this.endPoint.relayout(change);
  }
}

export class Slider extends Morph {
  constructor(props) {
    super({
      height: 20,
      fill: Color.transparent,
      draggable: false,
      ...props
    });
    const slider = this;
    this.submorphs = [
      new Path({
        borderColor: Color.gray.darker(),
        borderWidth: 2,
        vertices: [pt(0, 0), pt(this.width, 0)],
        position: pt(0, this.height/2)
      }),
      {
        type: "ellipse",
        fill: Color.gray,
        name: "slideHandle",
        borderColor: Color.gray.darker(),
        borderWidth: 1,
        dropShadow: {blur: 5},
        extent: pt(15, 15),
        nativeCursor: "-webkit-grab",
        getValue: () => {
          return num.roundTo(this.target[this.property], 0.01);
        },
        onDragStart(evt) {
          this.valueView = new Tooltip({description: this.getValue()}).openInWorld(
            evt.hand.position.addXY(10, 10)
          );
        },
        onDrag(evt) {
          slider.onSlide(this, evt.state.dragDelta);
          this.valueView.description = this.getValue();
          this.valueView.position = evt.hand.position.addXY(10, 10);
        },
        onDragEnd(evt) {
          this.valueView.remove();
        }
      }
    ];
    connect(this, "extent", this, "update");
    this.update();
  }

  normalize(v) {
    return Math.abs(v / (this.max - this.min));
  }

  update() {
    const x = (this.width - 15) * this.normalize(this.target[this.property]);
    this.get("slideHandle").center = pt(x + 7.5, 10);
  }

  onSlide(slideHandle, delta) {
    const oldValue = this.target[this.property],
          newValue = num.roundTo(oldValue + delta.x / this.width, 0.01);
    this.target[this.property] = Math.max(this.min, Math.min(this.max, newValue));
    this.update();
  }
}

export class ValueScrubber extends Text {
  static get properties() {
    return {
      autofit: {
        defaultValue: false,
        set(v) {
          this.fixedWidth = v;
          this.setProperty('autofit', v);
        }
      },
      value: {defaultValue: 0},
      fill: {defaultValue: Color.transparent},
      draggable: {defaultValue: true},
      min: {defaultValue: -Infinity},
      max: {defaultValue: Infinity},
      baseFactor: {defaultValue: 1},
      floatingPoint: {defaultValue: false}
    };
  }

  relayout() {
    const d = 5;
    if (!this.autofit) return;
    this.scale = Math.min(1, this.width / (this.textBounds().width + d));
  }

  onKeyDown(evt) {
    super.onKeyDown(evt);
    if ("Enter" == evt.keyCombo) {
      const [v, unit] = this.textString.split(" ");
      if (v) {
        this.value = parseFloat(v);
        signal(this, "scrub", this.scrubbedValue);
      }
      evt.stop();
    }
  }

  onDragStart(evt) {
    this.execCommand("toggle active mark");
    this.initPos = evt.position;
    this.factorLabel = new Tooltip({description: "1x"}).openInWorld(
      evt.hand.position.addXY(10, 10)
    );
  }

  getScaleAndOffset(evt) {
    const {x, y} = evt.position.subPt(this.initPos),
          scale = num.roundTo(Math.exp(-y / $world.height * 4), 0.01) * this.baseFactor;
    return {offset: x, scale};
  }

  onDrag(evt) {
    // x delta is the offset to the original value
    // y is the scale
    const {scale, offset} = this.getScaleAndOffset(evt),
          v = this.getCurrentValue(offset, scale);
    signal(this, "scrub", v);
    let valueString = this.floatingPoint ? v.toFixed(3) : obj.safeToString(v);
    if (this.unit) valueString += " " + this.unit;
    this.replace(this.documentRange, valueString, false, this.autofit, false, false);
    this.factorLabel.description = scale.toFixed(3) + "x";
    this.factorLabel.position = evt.hand.position.addXY(10, 10);
    this.relayout();
  }

  getCurrentValue(delta, s) {
    const v = this.scrubbedValue + (this.floatingPoint ? delta * s : Math.round(delta * s));
    return Math.max(this.min, Math.min(this.max, v));
  }

  onDragEnd(evt) {
    const {offset, scale} = this.getScaleAndOffset(evt);
    this.value = this.getCurrentValue(offset, scale);
    this.factorLabel.softRemove();
  }

  set value(v) {
    v = Math.max(this.min, Math.min(this.max, v));
    this.scrubbedValue = v;
    this.textString = this.floatingPoint ? v.toFixed(3) : obj.safeToString(v);
    if (this.unit) this.textString += " " + this.unit;
    this.relayout();
  }
}

export class CheckBox extends Morph {
  static get properties() {
    return {
      draggable: {defaultValue: false},
      extent: {defaultValue: pt(15, 15)},
      borderWidth: {defaultValue: 0},
      active: {defaultValue: true},
      checked: {defaultValue: false},
      fill: {defaultValue: Color.transparent},
      nativeCursor: {defaultValue: "pointer"}
    };
  }

  trigger() {
    try {
      this.checked = !this.checked;
      signal(this, "toggle", this.checked);
    } catch (err) {
      var w = this.world();
      if (w) w.logError(err);
      else console.error(err);
    }
  }

  onMouseDown(evt) {
    if (this.active) this.trigger();
  }

  render(renderer) {
    return renderer.renderCheckBox(this);
  }
}

export class LabeledCheckBox extends Morph {
  static example() {
    var cb = new LabeledCheckBox({label: "foo"}).openInWorld();
    // cb.remove()
  }

  static get properties() {
    return {
      name: {defaultValue: "LabeledCheckBox"},
      alignCheckBox: {
        defaultValue: "left",
        type: 'Enum',
        values: ['left', 'right'],
        set(v) {
          this.layout = new HorizontalLayout({
            direction: v == 'left' ? 'leftToRight' : 'rightToLeft'
          });
          this.setProperty('alignCheckBox', v);
        }
      },
      layout: {
        initialize() {
          this.layout = new HorizontalLayout({
            direction: this.alignCheckBox == 'left' ? 'leftToRight' : 'rightToLeft'
          });
        }
      },
      label: {
        defaultValue: "label",
        after: ["submorphs"],
        derived: true,
        get() {
          return this.labelMorph.value;
        },
        set(value) {
          this.labelMorph.value = value;
        }
      },
      checked: {
        after: ["submorphs"],
        derived: true,
        get() {
          return this.checkboxMorph.checked;
        },
        set(value) {
          this.checkboxMorph.checked = value;
          signal(this, "checked", value);
        }
      },
      active: {
        after: ["submorphs"],
        derived: true,
        get() {
          return this.checkboxMorph.active;
        },
        set(value) {
          this.checkboxMorph.active = value;
        }
      },
      labelMorph: {
        derived: true,
        readOnly: true,
        get() {
          return this.getSubmorphNamed("label");
        }
      },
      checkboxMorph: {
        derived: true,
        readOnly: true,
        get() {
          return this.getSubmorphNamed("checkbox");
        }
      },

      submorphs: {
        initialize() {
          this.submorphs = [
            new CheckBox({name: "checkbox"}),
            new Label({
              nativeCursor: "pointer",
              name: "label",
              padding: Rectangle.inset(5, 3)
            })
          ];
          connect(this, "alignCheckBox", this, "extent");
          connect(this.checkboxMorph, "checked", this, "checked");
        }
      }
    };
  }

  trigger() {
    this.checkboxMorph.trigger();
  }

  onMouseDown(evt) {
    if (this.active) this.trigger();
    evt.stop();
  }
}

export class ModeSelector extends Morph {
  static example() {
    var cb = new ModeSelector({items: {foo: {}}}).openInWorld();
    // cb.remove()
  }

  static get properties() {
    return {
      items: {
        set(items) {
          if (obj.isArray(items)) {
            this.keys = this.values = items;
          } else {
            this.keys = obj.keys(items);
            this.values = obj.values(items);
          }
        }
      },
      height: {defaultValue: 30},
      init: { },
      keys: { before: ['layout'] },
      values: { before: ['layout'] },
      tooltips: {},
      styleSheets: {
        initialize() {
          this.styleSheets = new StyleSheet({
            ".ModeSelector": {fill: Color.transparent, origin: pt(0, 5)},
            ".ModeSelector [name=typeMarker]": {fill: Color.gray.darker(), borderRadius: 3},
            ".ModeSelector .label": {
              fontWeight: "bold",
              nativeCursor: "pointer",
              padding: Rectangle.inset(4)
            }
          });
        }
      },
      layout: {
        after: ["items", 'keys', 'values'],
        initialize() {
          if (!this.keys) return;
          this.layout = new GridLayout({
            rows: [0, {paddingBottom: 10}],
            columns: [0, {fixed: 5}, this.keys.length + 2, {fixed: 5}],
            grid: [[null, ...arr.interpose(this.keys.map(k => k + "Label"), null), null]],
            autoAssign: false,
            fitToCell: false
          });
        }
      },
      submorphs: {
        after: ["items", 'keys', 'values'],
        initialize() {
          if (!this.keys) return;
          this.submorphs = [
            {name: "typeMarker"},
            ...this.createLabels(this.keys, this.values, this.tooltips)
          ];
          connect(this, "extent", this, "relayout", {converter: () => false});
          this.update(
            this.init ? this.init : this.keys[0],
            this.values[this.keys.includes(this.init) ? this.keys.indexOf(this.init) : 0],
            true
          );
        }
      }
    };
  }

  createLabels(keys, values, tooltips = {}) {
    return arr.zip(keys, values).map(([name, value]) => {
      const tooltip = tooltips[name],
            label = morph({
              name: name + "Label",
              styleClasses: ["label"],
              type: "label",
              value: name,
              autofit: true,
              ...(tooltip && {tooltip})
            });
      connect(label, 'onMouseDown', this, 'update', {
        updater: function($upd) {
          $upd(name, value);
        },
        varMapping: {name, value}
      });
      return label;
    });
  }

  async relayout(animated = true) {
    this.layout.forceLayout();
    let tm = this.get("typeMarker"),
        bounds = this.currentLabel.bounds();
    animated ? await tm.animate({bounds, duration: 200}) : tm.setBounds(bounds);
  }
  
  async update(label, value, silent = false) {
    const newLabel = this.get(label + "Label");
    if (newLabel == this.currentLabel) return;
    if (this.currentLabel) this.currentLabel.fontColor = Color.black;
    this.currentLabel = newLabel;
    newLabel.fontColor = Color.white;
    this.relayout(!silent);
    !silent && signal(this, label, value);
    !silent && signal(this, "switchLabel", value);
  }
}

export class DropDownSelector extends Morph {

  static get properties() {
    return {
      values: {defaultValue: []},
      getCurrentValue: {defaultValue: undefined},
      selectedValue: {
        after: ['submorphs', 'values', 'getCurrentValue'],
        set(v) {
          this.setProperty('selectedValue', v);
          this.relayout();
        }
      },
      fontColor: {isStyleProp: true, defaultValue: Color.black},
      fontSize: {isStyleProp: true, defaultValue: 12},
      fontFamily: {isStyleProp: true, defaultValue: 'Sans-Serif'},
      border: {defaultValue: {radius: 3, color: Color.gray.darker(), style: "solid"}},
      padding: {defaultValue: 1},
      isSelected: {
        defaultValue: "false",
        set(v) {
          this.setProperty("isSelected", v);
          this.fontColor = v ? Color.white : Color.black;
        }
      },
      layout: {
        initialize() {
          this.layout = new HorizontalLayout({spacing: this.padding});
        }
      },
      styleSheets: {
        after: ['fontFamily', 'fontSize'],
        initialize() {
          this.updateStyleSheet();
        }
      },
      submorphs: {
        initialize() {
          this.build();
        }
      }
    };
  }

  updateStyleSheet(args) {
    this.styleSheets = new StyleSheet({
      ".Label": {
        fontColor: this.fontColor,
        fontSize: this.fontSize,
        fontFamily: this.fontFamily
      },
      "[name=dropDownIcon]": {
        padding: rect(5,1,0,0),
        opacity: .8
      }
    });
    this.whenRendered().then(() => this.requestStyling());
  }

  build() {
    this.dropDownLabel = Icon.makeLabel("chevron-circle-down", {
      opacity: 0, name: 'dropDownIcon'
    });
    this.submorphs = [
      {
        type: "label",
        name: "currentValue",
      },
      this.dropDownLabel
    ];
    connect(this, 'onChange', this, 'updateStyleSheet');
  }

  getMenuEntries() {
    const currentValue = this.getNameFor(this.selectedValue);
    return [
      ...(this.selectedValue != undefined ? [{command: currentValue, target: this}] : []),
      ...arr.compact(
        this.commands.map(c => {
          return c.name != currentValue && {command: c.name, target: this};
        })
      )
    ];
  }

  get commands() {
    if (obj.isArray(this.values)) {
      return this.values.map(v => {
        return {
          name: String(v),
          exec: () => {
            signal(this, 'update', v);
            this.selectedValue = v;
          }
        };
      });
    } else {
      return properties.forEachOwn(this.values, (name, v) => {
        return {
          name,
          exec: () => {
            signal(this, 'update', v);
            this.selectedValue = v;
          }
        };
      });
    }
  }

  getNameFor(value) {
    if (this.getCurrentValue) return this.getCurrentValue();
    if (obj.isArray(this.values)) {
      return obj.safeToString(value);
    } else {
      return obj.safeToString(properties.nameFor(this.values, value));
    }
  }

  relayout() {
    const vPrinted = this.getNameFor(this.selectedValue),
          valueLabel = this.get("currentValue");
    if (vPrinted == "undefined") {
      valueLabel.value = "Not set";
      valueLabel.fontColor = Color.gray;
    } else {
      valueLabel.value = vPrinted;
      valueLabel.fontColor = Color.black;
    }
  }

  onHoverIn() {
    this.dropDownLabel.animate({opacity: 1, duration: 300});
  }

  onHoverOut() {
    this.dropDownLabel.animate({opacity: 0, duration: 200});
  }

  onMouseDown(evt) {
    this.menu = this.world().openWorldMenu(evt, this.getMenuEntries());
    this.menu.hasFixedPosition = true; // !!this.ownerChain().find(m => m.hasFixedPosition);
    this.menu.topLeft = this.globalPosition;
    //this.menu.isHaloItem = this.isHaloItem;
  }
}

export class SearchField extends Text {

  static get properties() {
    return {
      fixedWidth: {defaultValue: true},
      styleSheets: {
        after: ['selectedFontColor', 'idleFontColor'],
        initialize() {
          this.updateStyleSheet();
        }
      },
      selectedFontColor: { 
        isStyleProp: true,
        defaultValue: Color.black
      },
      idleFontColor: { 
        isStyleProp: true,
        defaultValue: Color.gray
      },
      borderColor: { defaultValue: Color.gray },
      layout: {
        initialize() {
          this.layout = new HorizontalLayout({autoResize: false, direction: 'rightToLeft'});
        }
      },
      fuzzy: {
        derived: true, after: ["filterFunction", "sortFunction"],
        set(fuzzy) {
          // fuzzy => bool or prop;
          this.setProperty("fuzzy", fuzzy);
          if (!fuzzy) {
            if (this.sortFunction === this.fuzzySortFunction)
              this.sortFunction = null;
            if (this.filterFunction === this.fuzzyFilterFunction)
              this.filterFunction = this.defaultFilterFunction;
          } else  {
            if (!this.sortFunction) this.sortFunction = this.fuzzySortFunction;
            if (this.filterFunction == this.defaultFilterFunction)
              this.filterFunction = this.fuzzyFilterFunction;
          }
        }
      },

      filterFunction: {
        get() {
          let filterFunction = this.getProperty("filterFunction");
          if (!filterFunction) return this.defaultFilterFunction;
          if (typeof filterFunction === "string")
            filterFunction = eval(`(${filterFunction})`);
          return filterFunction;
        }
      },

      sortFunction: {},

      defaultFilterFunction: {
        readOnly: true,
        get() {
          return this._defaultFilterFunction
              || (this._defaultFilterFunction = (parsedInput, item) =>
                parsedInput.lowercasedTokens.every(token =>
                  item.string.toLowerCase().includes(token)));
        }
      },

      fuzzySortFunction: {
        get() {
          return this._fuzzySortFunction
              || (this._fuzzySortFunction = (parsedInput, item) => {
                var prop = typeof this.fuzzy === "string" ? this.fuzzy : "string";
                // preioritize those completions that are close to the input
                var fuzzyValue = String(Path(prop).get(item)).toLowerCase();
                var base = 0;
                parsedInput.lowercasedTokens.forEach(t => {
                  if (fuzzyValue.startsWith(t)) base -= 10;
                  else if (fuzzyValue.includes(t)) base -= 5;
                });
                return arr.sum(parsedInput.lowercasedTokens.map(token =>
                  string.levenshtein(fuzzyValue.toLowerCase(), token))) + base;
              });
        }
      },

      fuzzyFilterFunction: {
        get() {
          return this._fuzzyFilterFunction
              || (this._fuzzyFilterFunction = (parsedInput, item) => {
                var prop = typeof this.fuzzy === "string" ? this.fuzzy : "string";
                var tokens = parsedInput.lowercasedTokens;
                if (tokens.every(token => item.string.toLowerCase().includes(token))) return true;
                // "fuzzy" match against item.string or another prop of item
                var fuzzyValue = String(Path(prop).get(item)).toLowerCase();
                return arr.sum(parsedInput.lowercasedTokens.map(token =>
                  string.levenshtein(fuzzyValue, token))) <= 3;
              });
        }
      },
      placeHolder: {defaultValue: 'Search'},
      submorphs: {
        after: ['placeHolder'],
        initialize() {
          this.submorphs = [
            {
              type: "label",
              name: 'placeholder',
              isLayoutable: false,
              value: this.placeHolder,
              reactsToPointer: false,
            },
            Icon.makeLabel("times-circle", {
              padding: rect(2,4,3,0),
              fontSize: 14,
              visible: false,
              fixedHeight: true,
              autofit: false,
              extent: pt(20,22),
              name: "placeholder icon",
              fontColor: Color.gray,
              nativeCursor: 'pointer'
            })
          ];
          connect(this.get('placeholder icon'), 'onMouseDown', this, 'clearInput');
        }
      }
    };
  }

  updateStyleSheet() {
    this.styleSheets = new StyleSheet({
      ".SearchField": {
        borderRadius: 15,
        borderWidth: 1,
        padding: rect(6, 3, 0, 0),
        clipMode: 'hidden'
      },
      ".SearchField [name=placeholder]": {
        padding: rect(6, 4, 0, 0),
        fontColor: this.selectedFontColor,
        opacity: .3
      },
      ".SearchField.idle": {
        fontColor: this.idleFontColor
      },
      ".SearchField.selected": {
        fontColor: this.selectedFontColor,
        dropShadow: {
          blur: 6,
          color: Color.rgb(52, 152, 219),
          fast: true,
          distance: 0
        }
      }
    });
  }

  parseInput() {
    var filterText = this.textString,
        // parser that allows escapes
        parsed = Array.from(filterText).reduce(
          (state, char) => {
            // filterText = "foo bar\\ x"
            if (char === "\\" && !state.escaped) {
              state.escaped = true;
              return state;
            }

            if (char === " " && !state.escaped) {
              if (!state.spaceSeen && state.current) {
                state.tokens.push(state.current);
                state.current = "";
              }
              state.spaceSeen = true;
            } else {
              state.spaceSeen = false;
              state.current += char;
            }
            state.escaped = false;
            return state;
          },
          {tokens: [], current: "", escaped: false, spaceSeen: false}
        );
    parsed.current && parsed.tokens.push(parsed.current);
    var lowercasedTokens = parsed.tokens.map(ea => ea.toLowerCase());
    return {tokens: parsed.tokens, lowercasedTokens};
  }

  clearInput() {
    this.textString = '';
    signal(this, "searchInput", this.parseInput());
    this.onBlur();
  }

  matches(string) {
    if (!this.textString) return true;
    return this.filterFunction.call(this, this.parseInput(), {string});
  }

  onChange(change) {
    super.onChange(change);
    let inputChange = change.selector === "replace",
        validInput = this.isFocused() && this.textString;
    if (this.get('placeholder icon')) this.get('placeholder icon').visible = !!this.textString;
    if (this.textString.includes('\n')) {
      this.textString = this.textString.replace('\n', '');
      this.owner.focus();
    }
    this.active && inputChange && signal(this, "searchInput", this.parseInput());
    if (['idleFontColor', 'selectedFontColor'].includes(change.prop))
       this.updateStyleSheet();
  }

  onBlur(evt) {
    super.onBlur(evt);
    this.active = false;
    this.get('placeholder').visible = !this.textString;
    this.animate({styleClasses: ["idle"], duration: 300});

  }

  onFocus(evt) {
    super.onFocus(evt);
    this.animate({styleClasses: ["selected"], duration: 300});
    this.get('placeholder').visible = false;
    this.active = true;
  }
}
