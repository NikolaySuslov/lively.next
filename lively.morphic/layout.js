import { pt, Rectangle, rect } from "lively.graphics";
import { arr, properties, Closure, num, grid, obj } from "lively.lang";
import {
  GridLayoutHalo, 
  ProportionalLayoutHalo,
  FlexLayoutHalo,
  TilingLayoutHalo
} from "lively.halos/layout.js";
import { once } from "lively.bindings";


class Layout {

  constructor(args = {}) {
    let {spacing, padding, border, container, manualUpdate,
         autoResize, ignore, onScheduleApply, layoutOrder,
         reactToSubmorphAnimations } = args;
    this.applyRequests = false;
    this.border = {top: 0, left: 0, right: 0, bottom: 0, ...border};
    this.ignore = ignore || [];
    this.lastBoundsExtent = this.container && this.container.bounds().extent();
    this.active = false;
    this.container = container;
    this.manualUpdate = manualUpdate;
    this.reactToSubmorphAnimations = reactToSubmorphAnimations || false;
    this.autoResize = autoResize != undefined ? autoResize : true;
    this.onScheduleApply = onScheduleApply || ((submorph, animation ,change) => {});
    if (layoutOrder) {
      this.layoutOrder = layoutOrder;
      this.layoutOrderSource = JSON.stringify(String(layoutOrder));
    }
    this.spacing = spacing || 0;
    this._padding = !padding ? null : typeof padding === "number" ? Rectangle.inset(padding) : padding;
  }

  attach() {
    this.apply();
    this.refreshBoundsCache();
  }
  
  copy() { return new this.constructor(this) }

  description() { return "Describe the layout behavior here."; }
  name() { return "Name presented to the user."; }

  isEnabled() { /*FIXME!*/ return !this.active; }
  disable() { this.active = true; }
  enable(animation) {
    this.active = false;
    this.scheduleApply(null, animation);
  }

  get padding() { return this._padding; }
  set padding(padding) {
    if (typeof padding === "number") {
      padding = Rectangle.inset(padding);
    }
    this._padding = padding;
    this.apply();
  }

  boundsChanged(container) {
    return !(this.lastBoundsExtent && container.bounds().extent().equals(this.lastBoundsExtent));
  }

  extentChanged(container) {
    return !(this.lastExtent && container.extent.equals(this.lastExtent));
  }

  get layoutableSubmorphs() {
    if (!this.layoutOrder)
      this.layoutOrder = Closure.fromSource(JSON.parse(this.layoutOrderSource)).recreateFunc();
    return arr.sortBy(
      this.container.submorphs.filter(
        m => m.isLayoutable && !this.ignore.includes(m.name)),
      m => this.layoutOrder(m));
  }

  layoutOrder(aMorph) {
    // helps orderdSubmorphs order my morphs
    return this.container.submorphs.indexOf(aMorph);
  }

  get submorphBoundsChanged() {
    let {layoutableSubmorphs, layoutableSubmorphBounds} = this;
    if (!layoutableSubmorphBounds
     || (layoutableSubmorphs.length != layoutableSubmorphBounds.length)) {
        return true;
    }
    for (let i = 0; i < layoutableSubmorphs.length; i++) {
      let m = layoutableSubmorphs[i],
          b = layoutableSubmorphBounds[i], nb;
      if (!b.equals(nb = m.bounds())) {
        return true;
      }
    }
    return false;
  }

  refreshBoundsCache() {    
    this.lastExtent = this.container.extent;
    this.layoutableSubmorphBounds = this.layoutableSubmorphs.map(m => m.bounds());
  }

  onContainerRender() {
    this.forceLayout();
  }

  get noLayoutActionNeeded() {
    return !this.submorphBoundsChanged
            && !this.boundsChanged(this.container)
            && !this.extentChanged(this.container)
            && !this.submorphsChanged
  }

  get __dont_serialize__() { return ['lastAnim', 'animationPromise'] }

  forceLayout() {
    if (this.applyRequests) {
      this.applyRequests = false;
      if (this.noLayoutActionNeeded) return;
      this.refreshBoundsCache();
      this.container.withMetaDo({
        isLayoutAction: true,
        animation: this.lastAnim
      }, () => this.apply(this.lastAnim));
      this.lastAnim = false;
    }
  }

  forceLayoutsInNextLevel() {
    function forceLayouts(m) {
      if (m.layout)
        m.layout.forceLayout();
      else
        m.submorphs.forEach(forceLayouts);
    }

    this.layoutableSubmorphs.forEach(forceLayouts)
  }

  scheduleApply(submorph, animation, change = {}) {
    if (typeof this.onScheduleApply === "function")
      this.onScheduleApply(submorph, animation, change);
    if (this.active) return;
    if (animation) this.lastAnim = animation;
    this.applyRequests = true;//{submorph, animation, change};
  }

  onSubmorphResized(submorph, change) {
    this.scheduleApply(submorph, this.reactToSubmorphAnimations && change.meta.animation, change)
  }
  onSubmorphAdded(submorph, animation) {
    this.submorphsChanged = true;
    this.scheduleApply(submorph, animation)
  }
  onSubmorphRemoved(submorph, animation) {
    this.submorphsChanged = true;
    this.scheduleApply(submorph, animation)
  }

  onChange({selector, args, prop, value, prevValue, meta}) {
    const anim = this.reactToSubmorphAnimations && meta && meta.animation,
          submorph = args && args[0];
    switch (selector) {
      case "removeMorph":
        this.onSubmorphRemoved(submorph, anim);
        break;
      case "addMorphAt":
        this.onSubmorphAdded(submorph, anim);
        break;
    }
    if (prop === "extent" && value && prevValue &&
        (prevValue.x !== value.x || prevValue.y !== value.y))
      this.scheduleApply(submorph, anim);
  }

  affectsLayout(submorph, {prop, value, prevValue}) {
    return ["position", "scale", "rotation", "isLayoutable", 'extent'].includes(prop)
           && !obj.equals(value, prevValue);
  }

  onSubmorphChange(submorph, change) {
    if (change.meta && change.meta.isLayoutAction)
      return this.scheduleApply(submorph, this.reactToSubmorphAnimation && change.meta.animation)
    if (this.affectsLayout(submorph, change)) {
       this.onSubmorphResized(submorph, change);
    }
  }

  changePropertyAnimated(target, propName, value, animate) {
    if (animate) {
      var {duration, easing} = animate;
      this.animationPromise = target.animate({[propName]: value, duration, easing});
    } else {
      target[propName] = value;
    }
  }

  attachAnimated(duration = 0, container, easing) {
    if (this.active) return;
    this.container = container;
    this.active = true;
    container.layout = this;
    this.active = false;
    this.lastAnim = { duration, easing };
  }

  apply(animated) {
    if (this.active) return;
    this.active = true;
    this.submorphsChanged = false;
    this.lastBoundsExtent = this.container && this.container.bounds().extent();
    this.active = false;
  }
}

export class CustomLayout extends Layout {

  constructor(config = {}) {
     this.relayout = config.relayout;
     // apply JSON stringification, since else the source string does not
     // survive serialization (improper escaping)
     this.layouterString = JSON.stringify(String(config.relayout));
     this.varMapping = config.varMapping || {};
     super(config);
  }

  name() { return "Custom Layout"; }

  apply(animate) {
     if (this.active || !this.container) return;
     super.apply(animate);
     this.active = true;
     if (!this.relayout) {
       this.relayout = Closure.fromSource(JSON.parse(this.layouterString),
         this.varMapping).recreateFunc();
     }
     try {
       this.relayout(this.container, animate);
     } catch (err) {
       console.error(`Error in relayout() of a custom layout:`, err);
     }
     this.lastBoundsExtent = this.container && this.container.bounds().extent();
     this.active = false;
  }

}


export class SnapLayout extends Layout {

  constructor(config = {}) {
    super(config);
    this._spacing = config.spacing;
  }

  name() { return "Snap" } 

  description() { return "Fits the parent morph to the combined bounds of all its submorphs."}
  
  apply(animate = false) {
    if (this.active || !this.container) return;
    super.apply(animate);
    const targetBounds = this.container.submorphBounds().insetBy(-this.spacing),
          submorphOffset = pt(this.spacing, this.spacing).subPt(targetBounds.topLeft());
    if (submorphOffset.r()) {
      this.container.submorphs.forEach(m => 
        this.changePropertyAnimated(m, 'position', m.position.addPt(submorphOffset), animate));
    }
    this.changePropertyAnimated(this.container, 'extent', targetBounds.extent(), animate);
  }
}

export class FillLayout extends Layout {

  constructor(config = {}) {
    super(config);
    this.morphs = config.morphs || [];
    this.fixedHeight = config.fixedHeight;
    this.fixedWidth = config.fixedWidth;
    this._spacing = 0;
  }

  name() { return "Fill" }

  description() { return "Forces all submorphs to match the extent of their owner."}

  set spacing(spacing = 0) {
     if (obj.isNumber(spacing)) {
        var top = left = right = bottom = spacing;
     } else {
        var {top, left, right, bottom} = spacing;
        top = top || 0;
        left = left || 0;
        right = right || 0;
        bottom = bottom || 0;
     }
     this._spacing = {top, left, right, bottom};
     this.apply();
  }

  get spacing() { return this._spacing }

  apply(animate = false) {
    /* FIXME: Add support for destructuring default values */
    if (this.active || !this.container) return;
    super.apply(animate);
    const {fixedWidth, fixedHeight} = this,
          {top, bottom, left, right} = this.spacing,
          height = !fixedHeight  && this.container.height - top - bottom,
          width = !fixedWidth && this.container.width - left - right;
    this.active = true;
    this.morphs.forEach(m => {
      if (!m.isLayoutable) return;
      var m = this.container.getSubmorphNamed(m),
          newBounds = pt(left,top).extent(pt(width || m.width, height || m.height));
      if (animate) {
         const {duration, easing} = animate;
         m.animate({bounds: newBounds, duration, easing});
      } else {
         m.setBounds(newBounds);
      }
    });
    this.active = false;
  }

  layoutOrder(aMorph) { return aMorph.top; }
}

class FloatLayout extends Layout {

  layoutOrder(aMorph) { return aMorph.left; }
}

export class VerticalLayout extends FloatLayout {

  constructor(props = {}) {
    super(props);
    // supported directions: "left", "center"
    this._resizeSubmorphs = typeof props.resizeSubmorphs !== "undefined" ?
                              props.resizeSubmorphs : false;
    this._align = props.align || "left";
  }

  name() { return "Vertical" }
  description() { return "Assemble the submorphs in a vertically growing list." }

  inspect(pointerId) {
    return new FlexLayoutHalo(this.container, pointerId);
  }

  equals(other) {
    if (!other.name || other.name() != 'Vertical') return false;
    if (this.spacing != other.spacing) return false;
    if (this.align != other.align) return false;
    //if (this.direction != other.direction) return false;
    return true;
  }

  get possibleAlignValues() { return ["left", "center", "right"]; }
  get align() { return this._align; }
  set align(d) { this._align = d; this.apply(); }

  get autoResize() { return this._autoResize; }
  set autoResize(active) { this._autoResize = active; this.apply(); }

  get spacing() { return this._spacing }
  set spacing(offset) { this._spacing = offset; this.apply(); }

  get resizeSubmorphs() { return this._resizeSubmorphs }
  set resizeSubmorphs(bool) { this._resizeSubmorphs = bool; this.apply(); }

  getSpec() {
    let { spacing, resizeSubmorphs, autoResize, align, padding, reactToSubmorphAnimations } = this;
    return { spacing, resizeSubmorphs, autoResize, align, padding, reactToSubmorphAnimations };
  }

  copy() {
    return new this.constructor(this.getSpec());
  }

  __serialize__() {
    return {
      __expr__: `new VerticalLayout(${JSON.stringify(this.getSpec())})`,
      bindings: {"lively.morphic": ["VerticalLayout"]}
    }
  }

  apply(animate = false) {
    if (this.active || !this.container) return;
    super.apply(animate);

    let {
          container,
          autoResize,
          resizeSubmorphs,
          spacing,
          align,
          layoutableSubmorphs,
          padding
        } = this,
        padLeft = padding ? padding.left() : 0,
        padRight = padding ? padding.right() : 0,
        padTop = padding ? padding.top() : 0,
        padBottom = padding ? padding.bottom() : 0,
        pos = pt(padLeft + spacing, padTop + spacing),
        containerWidth = container.width,
        submorphWidth = containerWidth - spacing*2 - padLeft - padRight,
        maxWidth = 0;

    this.active = true;
    for (let m of layoutableSubmorphs) {
      let {x: oldX, y: oldY} = m.position,
          {x: oldWidth} = m.extent,
          y = pos.y,
          x = pos.x,
          accessor = 'topLeft';
      // resize morphs now
      if (resizeSubmorphs && oldWidth !== submorphWidth)
        m.width = submorphWidth;
      if (align == 'center') {
        accessor = 'topCenter';
        x = containerWidth / 2;
      }
      if (align == 'right') {
        accessor = 'topRight';
        x = containerWidth - padRight - spacing;
      }
      if (oldX !== x || oldY !== y) {
        if (animate) {
          const {duration, easing} = animate;
          m.animate({[accessor]: pt(x, y), duration, easing});
        } else {
          m[accessor] = pt(x, y);
        }
      }
      pos = m.bottomLeft.addPt(pt(0, spacing));
      maxWidth = Math.max(m.bounds().width, maxWidth);
    }

    this.forceLayoutsInNextLevel();

    if (autoResize && layoutableSubmorphs.length > 0) {
      // resize vertically only
      const newExtent = pt(maxWidth + 2 * spacing + padLeft + padRight, padBottom + pos.y);
      if (animate) {
        const {duration, easing} = animate;
        this.container.animate({height: newExtent.y, duration, easing});
      } else {
        this.container.height = newExtent.y;
      }
    }
    this.lastBoundsExtent = this.container.bounds().extent();
    this.active = false;
  }

  layoutOrder(aMorph) { return aMorph.top; }
}

export class HorizontalLayout extends FloatLayout {

  constructor(props = {}) {
    super(props);
    // supported directions: "leftToRight", "rightToLeft", "centered"
    this._direction = props.direction || "leftToRight";
    // top, center, bottom
    this._align = props.align || "top";
  }

  name() { return "Horizontal"; }
  description() { return "Assemble the submorphs in a horizontally growing list."; }

  inspect(pointerId) { return new FlexLayoutHalo(this.container, pointerId); }

  get possibleDirectionValues() { return ["leftToRight", "rightToLeft", "centered"]; }
  get direction() { return this._direction; }
  set direction(d) { this._direction = d; this.apply(); }

  get possibleAlignValues() { return ["top", "center", "bottom"]; }
  get align() { return this._align; }
  set align(d) { this._align = d; this.apply(); }

  get autoResize() { return this._autoResize; }
  set autoResize(active) { this._autoResize = active; this.apply(); }

  get spacing() { return this._spacing; }
  set spacing(offset) { this._spacing = offset; this.apply(); }

  __serialize__() {
    return {
      __expr__: `new HorizontalLayout(${JSON.stringify(this.getSpec())})`,
      bindings: {"lively.morphic": ["HorizontalLayout"]}
    }
  }

  copy() {
    return new this.constructor(this.getSpec());
  }

  getSpec() {
    let { spacing, autoResize, align, direction, padding, reactToSubmorphAnimations } = this;
    return { spacing, autoResize, align, direction, padding, reactToSubmorphAnimations };
  }

  async apply(animate = false) {
    if (this.active || !this.container || !this.container.submorphs.length) return;

    var { direction, align, spacing, container, autoResize, layoutableSubmorphs } = this;

    if (!layoutableSubmorphs.length) return;

    super.apply(animate);
    this.active = true;
    this.maxHeight = 0;

    var minExtent = this.computeMinContainerExtent(spacing, container, layoutableSubmorphs);
    if (!autoResize) minExtent = minExtent.maxPt(container.extent);

    var startX = 0, rightToLeft = false;
    if (direction === "rightToLeft") {
      rightToLeft = true;
      layoutableSubmorphs = layoutableSubmorphs.reverse();
      startX = Math.max(0, container.width - 2 * spacing);
    } else if (direction === "centered") {
      let baseWidth = autoResize ? container.width - minExtent.x : minExtent.x,
          submorphW = (layoutableSubmorphs.length - 1) * spacing;
      for (let m of layoutableSubmorphs) submorphW = submorphW + m.bounds().width;
      startX = minExtent.x / 2 - submorphW / 2 - spacing;
    }

    if (autoResize) {
      var w = 0;
      if (direction === "centered") {
        var leftOffset = layoutableSubmorphs[0].left;
        w = arr.last(layoutableSubmorphs).right + leftOffset
      } else  {
        w = arr.last(layoutableSubmorphs).right + spacing;
      }
    
      var newExtent = pt(Math.max(minExtent.x, w), minExtent.y + 2 * spacing);
      this.changePropertyAnimated(container, "extent", newExtent, animate);
    }

    if (align === "top") {
      let top = spacing;
      layoutableSubmorphs.reduce((pos, m) => {
        this.changePropertyAnimated(m, rightToLeft ? "topRight" : "topLeft", pos, animate);
        return rightToLeft ? m.topLeft.subPt(pt(spacing, 0)) : m.topRight.addPt(pt(spacing, 0));
      }, pt(Math.max(0, startX) + spacing, top));
      this.forceLayoutsInNextLevel();

    } else if (align === "bottom") {
      let bottom = minExtent.y + (autoResize ? spacing : -spacing);
      layoutableSubmorphs.reduce((pos, m) => {
        this.changePropertyAnimated(m, rightToLeft ? "bottomRight" : "bottomLeft", pos, animate);
        return rightToLeft ? m.bottomLeft.subPt(pt(spacing, 0)) : m.bottomRight.addPt(pt(spacing, 0));
      }, pt(Math.max(0, startX) + spacing, bottom));
       this.forceLayoutsInNextLevel();
    } else { // centered
      let yCenter = container.height/2;      
      layoutableSubmorphs.reduce((pos, m) => {
        this.changePropertyAnimated(m, rightToLeft ? "rightCenter" : "leftCenter", pos, animate);
        return rightToLeft ? m.leftCenter.subPt(pt(spacing, 0)) : m.rightCenter.addPt(pt(spacing, 0));
      }, pt(Math.max(0, startX) + spacing, yCenter));
      this.forceLayoutsInNextLevel();
    }

    this.lastBoundsExtent = this.container.bounds().extent();
    this.active = false;
    return this.animationPromise;
  }

  equals(other) {
    if (!other.name || other.name() != 'Horizontal') return false;
    if (this.spacing != other.spacing) return false;
    if (this.align != other.align) return false;
    if (this.direction != other.direction) return false;
    return true;
  }

  computeMinContainerExtent(spacing, container, layoutableSubmorphs) {
    var spacingWidth = (layoutableSubmorphs.length + 1) * spacing;
    var maxW = 0, maxH = 0;
    for (var i = 0; i < layoutableSubmorphs.length; i++) {
      let m = layoutableSubmorphs[i],
          {x: w, y: h} = m.extent;
      maxW += w;
      maxH = Math.max(h, maxH);
    }
    return pt(maxW + spacingWidth, maxH)
  }

}


export class ProportionalLayout extends Layout {

  name() { return "Proportional" }
  description() { return "Resizes, scales, and moves morphs according to their original position." }

  inspect(pointerId) {
    // return new ProportionalLayoutHalo(this.container, pointerId);
    return new ProportionalLayoutHalo(this.container, pointerId);
  }

  constructor(args) {
    super(args);
    this.extentDelta = pt(0,0);
    this.proportionalLayoutSettingsForMorphs = new WeakMap();
    this.submorphSettings = (args && args.submorphSettings) || [];
  }

  get __dont_serialize__() { return [...super.__dont_serialize__, 'extentDelta', 'lastExtent'] }

  __after_deserialize__(snapshot, ref) {
    let {_submorphSettings, container} = this,
        map = this.proportionalLayoutSettingsForMorphs || new WeakMap();
    this.extentDelta = pt(0,0);
    if (!_submorphSettings || !container) return;
    for (let [ident, setting] of _submorphSettings) {
      let [morph] = this._morphsMatchingSelector(container, ident);
      morph && map.set(morph, setting);
    }
    this.proportionalLayoutSettingsForMorphs = map;
  }

  onSubmorphChange(submorph, change, x ,y) {
    if (change.prop === "name") {
      let settings = this.proportionalLayoutSettingsForMorphs.get(submorph);
      if (settings) this.changeSettingsFor(submorph, settings, true);
    }
    return super.onSubmorphChange(submorph, change);
  }

  settingsFor(morph) {
    // move, resize, scale, fixed
    let settings = this.proportionalLayoutSettingsForMorphs.get(morph);
    return settings || {x: "scale", y: "scale"};
  }

  changeSettingsFor(morph, mergin, save = false) {
    if (typeof mergin === "string") mergin = {x: mergin, y: mergin};
    this.proportionalLayoutSettingsForMorphs
      .set(morph, {...this.settingsFor(morph), ...mergin});
    if (save) {
      let settings = this.submorphSettings.filter(ea => ea[0] !== morph.name);
      settings.push([morph.name, this.settingsFor(morph)]);
      this._submorphSettings = settings;
    }
  }

  get submorphSettings() { return this._submorphSettings; }
  set submorphSettings(submorphSettings) {
    if (!this.container) {
      once(this, "container", this, "submorphSettings",
        {converter: () => submorphSettings, varMapping: {submorphSettings}});
      return;
    }
    this._submorphSettings = submorphSettings;
    this.changeSubmorphSettings(submorphSettings);
  }

  changeSubmorphSettings(submorphSettings) {
    for (let [morphSelector, setting] of submorphSettings) {
      let morphs = this._morphsMatchingSelector(this.container, morphSelector);
      morphs.forEach(m => this.changeSettingsFor(m, setting));
    }
  }

  _morphsMatchingSelector(container, selector) {      
    let morphs = [];
    if (!selector) return morphs;
    if (selector.isMorph) {
      morphs = [selector];
    } else if (selector instanceof RegExp) {
      morphs = container.submorphs.filter(ea => ea.name.match(selector));
    } else if (typeof selector === "string") {
      morphs = container.submorphs.filter(ea => ea.name === selector);
    } else if (Array.isArray(selector)) {
      morphs = arr.flatmap(selector, sel => this._morphsMatchingSelector(container, sel));
    }
    return morphs;
  }

  refreshBoundsCache() {    
    let {container: {extent}, lastExtent} = this;
    if (lastExtent && !extent.eqPt(lastExtent))
      this.extentDelta = this.extentDelta.addPt(extent.subPt(lastExtent));
    this.lastExtent = extent;
    this.layoutableSubmorphBounds = this.layoutableSubmorphs.map(m => m.bounds());
  }

  apply(animate = false) {
    let {container, active, extentDelta: {x: deltaX, y: deltaY}} = this,
        {extent} = container || {};
    if (active || !container || (deltaX == 0 && deltaY == 0))
      return;

    this.extentDelta = pt(0,0);
    this.active = true;
    super.apply(animate);

    let {layoutableSubmorphs} = this;

    var scalePt = extent.scaleByPt(extent.addXY(-deltaX, -deltaY).invertedSafely());
    for (let m of layoutableSubmorphs) {
      let {x, y} = this.settingsFor(m),
          moveX = 0, moveY = 0, resizeX = 0, resizeY = 0;
      
      if (x === "move") moveX = deltaX;
      if (y === "move") moveY = deltaY;
      if (x === "resize") resizeX = deltaX;
      if (y === "resize") resizeY = deltaY;
      
      if (x === "scale" || y === "scale") {
        var morphScale = pt(
          x === "scale" ? scalePt.x : 1,
          y === "scale" ? scalePt.y : 1);
        m.position = m.position.scaleByPt(morphScale);
        m.extent = m.extent.scaleByPt(morphScale);
      }
      
      if (moveX || moveY) m.moveBy(pt(moveX, moveY));
      if (resizeX || resizeY) m.extent = m.extent.addXY(resizeX, resizeY);

    }

    this.forceLayoutsInNextLevel();

    // this.lastExtent = extent;
    this.active = false;
  }

}

export class TilingLayout extends Layout {

  constructor(props = {}) {
    super(props);
    this._axis = props.axis || 'row';
    this._align = props.align || 'left';
  }
  
  name() { return "Tiling" }

  description() { return "Make the submorphs fill their owner, inserting breaks to defer intersecting the bounds as much as possible." }

  inspect(pointerId) {
    return new TilingLayoutHalo(this.container, pointerId);
  }

  get axis() { return this._axis }
  set axis(a) { this._axis = a; this.apply() }

  get align() { return this._align }
  set align(a) { this._align = a; this.apply() }

  get spacing() { return this._spacing; }
  set spacing(offset) { this._spacing = offset; this.apply(); }

  apply(animate = false) {
    if (this.active || !this.container) return;

    this.active = true;
    super.apply(animate);

    let {container, axis, align, border, spacing, layoutableSubmorphs} = this,
        width = this.getOptimalWidth(container),
        isHorizontal = axis == "row",
        widthAccessor = isHorizontal ? 'left' : 'top',
        heightAccessor = isHorizontal ? 'top' : 'left', 
        normalizedWidthAccessor = isHorizontal ? 'x' : 'y', 
        normalizedHeightAccessor = isHorizontal ? 'y' : 'x',
        currentRowHeight = 0,
        previousRowHeight = spacing + border[heightAccessor];

    while (layoutableSubmorphs.length) {

      var remainingWidth = width - spacing,
          rowMorphs = arr.takeWhile(layoutableSubmorphs, m => {
            var ext = m.extent,
                newWidth = remainingWidth - (ext[normalizedWidthAccessor] + spacing);
            if (newWidth < 0) return false;
            remainingWidth = newWidth;
            return true;
          });

      if (rowMorphs.length) layoutableSubmorphs.splice(0, rowMorphs.length);
      else {
        rowMorphs = [layoutableSubmorphs.shift()]
        remainingWidth = 0;
      }

      var pos;

      if (isHorizontal) {
        pos = "center" === align ?
          pt(remainingWidth/2 + spacing + border[widthAccessor], previousRowHeight) :
          pt(spacing, previousRowHeight);

      } else {
        pos = "center" === align ?
          pt(previousRowHeight, remainingWidth/2 + spacing + border[widthAccessor]) :
          pt(previousRowHeight, spacing);
      }

      for (let m of rowMorphs) {
        if (animate) {
          const {duration, easing} = animate;
          m.animate({position: pos, duration, easing});
        } else {
          m.position = pos;
        }
        pos = isHorizontal ?
          pos.addXY(spacing + m.extent[normalizedWidthAccessor], 0) :
          pos.addXY(0, spacing + m.extent[normalizedWidthAccessor]);
        currentRowHeight = Math.max(currentRowHeight, m.extent[normalizedHeightAccessor]);
      }

      previousRowHeight += spacing + currentRowHeight;
      currentRowHeight = 0;
    }

    this.active = false;
  }

  getMinWidth() {
    var {layoutableSubmorphs, border: {left, right}} = this;
    return layoutableSubmorphs.reduce((s, m) =>
      (m.width > s) ? m.width : s, 0) + left + right;
  }

  getMinHeight() {
    var {layoutableSubmorphs, border: {top, bottom}} = this;
    return layoutableSubmorphs.reduce((s, e) =>
      (e.height > s) ? e.height : s, 0) + top + bottom;
  }

  getOptimalWidth(container) {
    var {axis, border: {left, top, right, bottom}} = this,
        width = axis == 'row' ? 
                   container.width - left - right :
                   container.height - top - bottom,
        maxSubmorphWidth = axis == 'row' ? this.getMinWidth() : this.getMinHeight();
    return Math.max(width, maxSubmorphWidth);
  }

  layoutOrder(morph) {
    // the following creates a drop zone that is 15 pixels tall.
    // allows for horizontal reordering.
    return (morph.top - morph.top % 15) * 1000000 + morph.left;
  }

}

export class CenteredTilingLayout extends TilingLayout {

  name() { return "CenteredTiling" }
  description() { return "Similar to TilingLayout but center the rows." }

  apply(animate = false) {
    if (this.active || !this.container) return;

    this.active = true;
    super.apply(animate);

    var width = this.getOptimalWidth(this.container),
        {spacing, layoutableSubmorphs} = this,
        y = spacing + this.border.top;

    layoutableSubmorphs = layoutableSubmorphs.slice();

    while (layoutableSubmorphs.length) {

      let remainingWidth = width;
      let rowMorphs = arr.takeWhile(layoutableSubmorphs, m => {
        let newWidth = remainingWidth - (m.width + 2*spacing);
        if (newWidth < 0) return false;
        remainingWidth = newWidth;
        return true;
      })

      if (rowMorphs.length) layoutableSubmorphs = arr.withoutAll(layoutableSubmorphs, rowMorphs);
      else {
        rowMorphs = [layoutableSubmorphs.shift()]
        remainingWidth = 0;
      };

      let pos = pt(remainingWidth/2 + spacing + this.border.left, y);
      for (let m of rowMorphs) {
        m.position = pos;
        pos = pos.addXY(2*spacing + m.width, 0);
        y = Math.max(y, m.bottom)
      }

      y += 2*spacing;
    }

    this.active = false;
  }

}

export class CellGroup {

  constructor({cell, morph, layout, align}) {
    this.state = {cells: [cell], layout, align, resize: layout.fitToCell};
    layout && layout.addGroup(this);
    this.morph = morph;
  }

  get morph() {
    var {morph, layout} = this.state;
    if (morph) {
      if (morph.isMorph) return morph;
      return layout.layoutableSubmorphs.find(m => m.name == morph);
    }
    return null;
  }

  get compensateOrigin() { return this.layout.compensateOrigin }

  get resize() { return this.state.resize }
  set resize(forceBounds) { this.state.resize = forceBounds; this.layout.apply() }

  get align() { return this.state.align || "topLeft" }
  set align(orientation) {
      this.state.align = orientation;
      this.layout.apply();
  }

  set morph(value) {
    const conflictingGroup = value && this.layout.getCellGroupFor(value);
    if (conflictingGroup) conflictingGroup.morph = null;
    this.state.morph = value;
    this.layout.apply();
  }

  manages(morph) {
    return this.morph && (this.morph == morph || this.morph.name == morph)
  }

  apply(animate = false) {
    var target = this.morph;
    if(target) {
      const bounds = this.bounds(),
            offset = this.compensateOrigin ? this.layout.container.origin.negated() : pt(0,0)
      if (animate) {
        var extent = this.resize ? bounds.extent() : target.extent,
            {duration, easing} = animate;
        target.animate({
          [this.alignedProperty || this.align]: bounds[this.align]().addPt(offset),
          extent,
          duration,
          easing
        });
      } else {
        if (this.resize) target.extent = bounds.extent();
        target[this.alignedProperty || this.align] = bounds[this.align]().addPt(offset);
      }
      this.layout.forceLayoutsInNextLevel();
    }
  }

  get cells() { return this.state.cells; }

  get layout() { return this.state.layout; }

  bounds() {
    if (this.cells.length > 0) {
      return this.cells
                 .map(cell => cell.bounds())
                 .reduce((a,b) => a.union(b));
    } else {
      return rect(0,0,0,0);
    }
  }

  includes(cell) {
    return this.cells.find(c => c == cell);
  }

  connect(cell) {
    // connect partial row and col ?
    if (this.morph == undefined) {
      this.morph = cell.group.morph;
    }
    if(cell.group) {
      cell.group.disconnect(cell, this);
    } else {
      cell.group = this;
    }
    this.cells.push(cell);
  }

  disconnect(cell, newGroup=null) {
    cell.group = newGroup || new CellGroup({morph: null, layout: this.layout, cell});
    arr.remove(this.cells, cell);
    if (this.cells.length < 1 && this.layout) this.layout.removeGroup(this);
  }

  merge(otherGroup) {
    otherGroup.cells.forEach(c => {
      this.connect(c);
    })
  }

  get topLeft() {
    return this.cells.find(cell =>
        (cell.left == null || cell.left.group != this) &&
        (cell.top == null || cell.top.group != this));
  }

  get bottomRight() {
    return this.cells.find(cell =>
        (cell.right == null || cell.right.group != this) &&
        (cell.bottom == null || cell.bottom.group != this));
  }

  get position() {
    return this.topLeft.position;
  }

}

/*
  Combines the concept of rows and columns. Each row or column (axis) defines its width or height
  (its length) by an absolute number of pixels.
  An Axis can be either fixed or proportional. Proportional axis adjust their width
  upon change of the container's extent. This is done by computing the ratio of the the
  axis' length to to the containers width or height that is made up of proportional
  axis respectively.
  The ratio is then used to compute the new adjusted width of the column in turn.
  This saves us from juggling with ratios and absolute values and mediate between
  fixed and proportional axis more easily.

*/

class LayoutAxis {

  constructor(cell) {
      this.origin = cell;
  }

  get otherAxis() {
    return [...this.axisBefore, ...this.axisAfter]
  }
  get axisBefore() {
    var curr = this, res = [];
    while (curr = curr.before) res = [curr, ...res]
    return res;
  }
  get axisAfter() {
    var curr = this, res = [];
    while (curr = curr.after) res = [...res, curr];
    return res;
  }

  get before() { throw Error("before() not implemented!") }
  get after() { throw Error("after() not implemented!") }

  get containerLength() { return this.container[this.dimension] }
  set containerLength(length) { this.container[this.dimension] = length; }

  getRoot() {
    return (this.axisBefore[0] || this).items[0];
  }

  get container() { return this.origin.container }
  get layout() { return this.origin.layout }

  get frozen() { return this.origin.frozen[this.dimension] }
  set frozen(active) { this.origin.frozen[this.dimension] = active}

  set align(align) {
    this.items.forEach(c => c.group.state.align = align);
  }

  get fixed() { return this.origin.fixed[this.dimension] }
  set fixed(active) {
    var newLength, containerLength;
    if (obj.isNumber(active)) {
      newLength = active;
      active = true;
    }
    this.items.forEach(c => {
      c.fixed[this.dimension] = active;
    });
    containerLength = this.containerLength;
    if (newLength) this[this.dimension] = newLength;
    this.adjustOtherProportions(active)
    this.containerLength = containerLength; // force length
  }

  get length() { return this.origin[this.dimension]; }
  set length(x) {
    this.items.forEach(cell => {
      cell[this.dimension] = num.roundTo(x, 1);
    });
  }

  get proportion() { return this.origin.proportion[this.dimension]; }
  set proportion(prop) {
    this.items.forEach(cell => {
      cell.proportion[this.dimension] = prop;
    });
  }

  get min() { return this.origin.min[this.dimension]; }
  set min(x) { this.adjustMin(x - this.min); }

  adjustMin(delta) {
    this.items.forEach(c => {
      if (c.min[this.dimension] + delta < 0) {
        c.min[this.dimension] = 0;
      } else if (c.min[this.dimension] + delta > c[this.dimension] ) {
        c.min[this.dimension] += delta;
      } else {
        c.min[this.dimension] += delta;
      }
    });
    this.layout.apply()
  }

  /*
   In order to be numerically stable (lengths go to very small values or 0)
   axis and cells need to store their dynamic proportion which is used in turn to
   compute their current length.
   Proportions are ONLY updated when one of the following things happen:
   1. An axis becomes or stops being fixed.
   2. An axis reaches its minimum length
   3. An axis adjusts its length via the width or height property
   4. A new axis is introduced to the grid
  */

  adjustProportion() {
    if (!this.fixed) this.proportion = this.dynamicLength > 0 ? this.length / this.dynamicLength : 0;
  }

  adjustOtherProportions(remove) {
    const before = this.axisBefore, after = this.axisAfter,
          dynamicProportions = arr.sum([...before, ...after].filter(a => !a.fixed).map(a => a.proportion)),
          removeOwnProportion = c => c.proportion = c.proportion / dynamicProportions,
          insertOwnProportion = c => c.proportion = c.proportion * this.origin.removedDynamicProportions;
    if (remove) this.origin.removedDynamicProportions = dynamicProportions;
    before.forEach(remove ? removeOwnProportion : insertOwnProportion);
    after.forEach(remove ? removeOwnProportion : insertOwnProportion);
  }

  prepareForResize(newContainerLength) {
    const newLength = this.proportion * Math.max(0, newContainerLength - this.staticLength);
    if (this.frozen && newLength >= this.min) {
       this.frozen = false;
       this.fixed = false;
       this.length = newLength;
    } else if (!this.frozen && this.min > newLength) {
       this.frozen = true;
       this.fixed = true;
       this.length = this.min;
    }
    return this;
  }

  adjustLength(delta) {
    var nextDynamicAxis;
    if (this.length + delta < 0) // trunkate delta
        delta = -this.length;
    if (nextDynamicAxis = this.axisAfter.find(axis => !axis.fixed)) {
      delta = Math.min(delta, nextDynamicAxis.length);
      this.length += delta
      nextDynamicAxis.length -= delta;
      this.adjustProportion();
      nextDynamicAxis.adjustProportion();
    } else {
      // we are either the last axis
      nextDynamicAxis = this.axisBefore.reverse().find(axis => !axis.fixed);
      if (nextDynamicAxis) {
        nextDynamicAxis.length -= delta;
        this.length += delta;
        this.adjustProportion();
        nextDynamicAxis.adjustProportion();
      } else {
        //or there are no axis to steal from
        this.length += delta;
        this.adjustProportion();
        this.otherAxis.forEach(a => a.adjustProportion());
        this.containerLength += delta;
      }
    }
  }

  equalizeDynamicAxis() {
    var dynamicAxis = [...this.otherAxis.filter(a => !a.fixed), ...this.fixed ? [] : [this]],
        l = (this.containerLength - this.staticLength) / dynamicAxis.length;
    dynamicAxis.map(a => {
      if (!a.fixed) a.length = l;
      return a;
    }).forEach(a => a.adjustProportion());
  }

  addBefore() {
    const newAxis = this.emptyAxis();
    this.before && this.before.attachTo(newAxis);
    newAxis.attachTo(this);
    this.equalizeDynamicAxis();
    this.layout.grid = this.getRoot();
  }

  addAfter() {
    const newAxis = this.emptyAxis();
    this.after && newAxis.attachTo(this.after);
    this.attachTo(newAxis);
    this.equalizeDynamicAxis();
    this.layout.grid = this.getRoot();
  }

}

export class LayoutColumn extends LayoutAxis {

  constructor(cell) {
    super(cell);
    this.items = [...cell.above, cell, ...cell.below];
  }

  get dimension() { return 'width' }

  get before() { return this._before || (this._before = this.origin.left && new LayoutColumn(this.origin.left)) }
  get after() { return this._after || (this._after = this.origin.right && new LayoutColumn(this.origin.right)) }

  row(idx) { return this.items[idx]; }

  get dynamicLength() { return this.origin.dynamicWidth }
  get staticLength() { return this.origin.totalStaticWidth }

  get width() { return this.length}
  set width(w) {
    const delta = w - this.width;
    if (this.fixed) {
      this.length += delta;
      this.container.width += delta;
    } else {
      this.adjustLength(delta);
    }
    !this.layout.manualUpdate && this.layout.apply();
  }

  set paddingLeft(left) {
     this.items.forEach(c => {
        c.padding.x = left;
     });
     this.layout.apply();
  }

  get paddingLeft() { return this.items[0].padding.x }

  set paddingRight(right) {
     this.items.forEach(c => {
        c.padding.width = right;
     });
     this.layout.apply();
  }

  get paddingRight() { return this.items[0].padding.width }

  emptyAxis() {
    const col = new LayoutColumn(new LayoutCell({
         column: arr.withN(this.items.length, null),
         layout: this.layout
    }));
    arr.zip(col.items, this.items).forEach(([n, o]) => {
      n.height = o.height;
      n.fixed.height = o.fixed.height;
      n.frozen.height = o.frozen.height;
      n.proportion.height = o.proportion.height;
      n.min.height = o.min.height;
    })
    return col;
  }

  attachTo(col) {
    this.after && (this.after._before = null);
    this._after = null;
    arr.zip(this.items, col.items)
       .forEach(([a, b]) => {
         a.right = b;
         b.left = a;
       });
    this.equalizeDynamicAxis();
    return col
  }

  remove() {
    const a = this.before || this.after;
    this.items.forEach(c => {
      if (c.left) c.left.right = c.right;
      if (c.right) c.right.left = c.left;
      c.group.disconnect(c);
      this.layout.removeGroup(c.group);
    });
    this.before && (this.before._after = null);
    this.after && (this.after._before = null);
    if (!this.before) {
      this.layout.grid = this.after.getRoot();
    }
    a.equalizeDynamicAxis();
  }

}

export class LayoutRow extends LayoutAxis {

  constructor(cell) {
    super(cell);
    this.items = [...cell.before, cell, ...cell.after];
  }

  get dimension() { return 'height' }

  emptyAxis() {
    const row = new LayoutRow(new LayoutCell({
         row: arr.withN(this.items.length, null),
         layout: this.layout
    }));

    arr.zip(row.items, this.items).forEach(([n, o]) => {
      n.width = o.width;
      n.fixed.width = o.fixed.width;
      n.frozen.width = o.frozen.width;
      n.proportion.width = o.proportion.width;
      n.min.width = o.min.width;
    })
    return row;
  }

  set paddingTop(top) {
    this.items.forEach(c => {
       c.padding.y = top;
    });
    this.layout.apply();
  }

  get paddingTop() { return this.items[0].padding.y }

  set paddingBottom(bottom) {
    this.items.forEach(c => {
       c.padding.height = bottom;
    });
    this.layout.apply();
  }

  get paddingBottom() { return this.items[0].padding.height }

  get before() { return this._before || (this._before = this.origin.top && new LayoutRow(this.origin.top)) }
  get after() { return this._after || (this._after = this.origin.bottom && new LayoutRow(this.origin.bottom)) }

  get dynamicLength() { return this.origin.dynamicHeight }
  get staticLength() { return this.origin.totalStaticHeight }

  attachTo(row) {
    this.after && (this.after._before = null);
    this._after = null;
    arr.zip(this.items, row.items)
       .forEach(([a, b]) => {
          a.bottom = b;
          b.top = a;
      });
    this.equalizeDynamicAxis();
    return row
  }

  col(idx) { return this.items[idx]; }

  get height() { return this.length }
  set height(h) {
    const delta = h - this.height;
    if (this.fixed) {
      this.length += delta;
      this.container.height += delta;
    } else {
      this.adjustLength(delta);
      this.proportion = this.origin.dynamicHeight > 0 ? this.height / this.origin.dynamicHeight : 0;
    }
    !this.layout.manualUpdate && this.layout.apply();
  }

  remove() {
    const a = this.before || this.after;
    this.items.forEach(c => {
      if (c.top) c.top.bottom = c.bottom;
      if (c.bottom) c.bottom.top = c.top;
      c.group.disconnect(c);
      this.layout.removeGroup(c.group);
    });
    this.before && (this.before._after = null);
    this.after && (this.after._before = null);
    if (!this.before) {
      this.layout.grid = this.after.getRoot();
    }
    a.equalizeDynamicAxis();
  }

}

export class LayoutCell {

  constructor({row, column,
               top, left, right, bottom,
               layout}) {
    var group,
        [rv, ...row] = row || [],
        [cv, ...column] = column || [];

    this.layout = layout;
    this.fixed = {width: false, height: false};
    this.frozen = {width: false, height: false};
    this.min = {width: 0, height: 0};
    this.top = top; this.left = left;
    this.bottom = bottom; this.right = right;

    this.padding = rect(0,0,0,0);

    if (row.length > 0) {
      this.right = new LayoutCell({row, left: this, layout});
    } else if (column.length > 0) {
      this.bottom = new LayoutCell({column, top: this, layout});
    }

    this.proportion = {
       width: 1 / (1 + this.before.length + this.after.length),
       height: 1 / (1 + this.above.length + this.below.length)
    };

    this.height = this.container.height * this.proportion.height;
    this.width = this.container.width * this.proportion.width;

    if (group = layout && layout.getCellGroupFor(rv || cv)) {
      group.connect(this);
    } else {
      this.group = new CellGroup({cell: this, morph: rv || cv, layout});
    }
  }

  get container() { return this.layout.container }

  get above() { return this.collect({neighbor: "top", prepend: true}) }

  get below() { return this.collect({neighbor: "bottom", append: true}) }

  get before() { return this.collect({neighbor: "left", prepend: true}) }

  get after() { return this.collect({neighbor: "right", append: true}) }

  collect({neighbor, prepend, append}) {
    var items = [], curr = this;
    while (curr = curr[neighbor]) {
      if (prepend) items = [curr, ...items];
      if (append) items = [...items, curr];
    }
    return items
  }

  col(idx) {
    var cell = this, i = idx;
    while (i > 0 && cell) {
      cell = cell.right;
      i--;
    }
    if (!cell) throw Error(`${idx} out of bounds! Last column was ${idx - i - 1}`);
    return new LayoutColumn(cell);
  }

  row(idx) {
    var cell = this, i = idx;
    while (i > 0 && cell) {
      cell = cell.bottom;
      i--;
    }
    if (!cell) throw Error(`${idx} out of bounds! Last row was ${idx - i - 1}`);
    return new LayoutRow(cell);
  }

  get extent() {
    return pt(this.width, this.height);
  }

  get staticWidth() { return this.fixed.width || (this.min.width == this.width) }
  get staticHeight() { return this.fixed.height || (this.min.height == this.height) }

  get totalStaticWidth() {
    return arr.sum(
             [this, ...this.before, ...this.after]
              .filter(c => c.staticWidth)
              .map(c => c.width)
            );
  }

  get totalStaticHeight() {
    return arr.sum(
             [this, ...this.above, ...this.below]
               .filter(c => c.staticHeight)
               .map(c => c.height)
           );
  }

  get dynamicWidth() {
    return arr.sum(
             [this, ...this.before, ...this.after]
              .filter(c => !c.staticWidth)
              .map(c => c.width)
            );
  }

  get dynamicHeight() {
        return arr.sum([this, ...this.above, ...this.below]
              .filter(c => !c.staticHeight)
              .map(c => c.height));
  }

  get height() { return Math.max(this.min.height, this._height || 0) }
  set height(h) {
    this._height = h;
  }

  get width() { return Math.max(this.min.width, this._width || 0) }
  set width(w) {
    this._width = w;
  }

  get position() {
    return pt(arr.sum(this.before.map(c => c.width)),
              arr.sum(this.above.map(c => c.height)));
  }

  bounds() {
    return this.position.addPt(this.padding.topLeft())
               .extent(this.extent.subPt(this.padding.extent())
                                  .subPt(this.padding.topLeft()));
  }

}

export class GridLayout extends Layout {

  constructor(config) {
    super(config);
    config = {autoAssign: true, fitToCell: true, ...config};
    this.cellGroups = [];
    this.config = config;
  }

  name() { return "Grid" }
  description() { return "Aligns the submorphs alongside a configurable grid. Columns and rows and be configured to have different proportional, minimal or fixed sizes. Cells can further be grouped such that submorphs fill up multiple slots of the grid." }


  copy() {
    return new this.constructor(this.getSpec());
  }
  
  getSpec() {
    let grid = [];
    let rows = [];
    let columns = [];
    let groups = {};
    for (let r of arr.range(0, this.rowCount - 1)) {
      grid.push(this.grid.row(r).items.map(item => item.group.morph ? item.group.morph.name : null));
    }
    for (let r of arr.range(0, this.rowCount - 1)) {
      let row = this.grid.row(r);
      rows.push(r, {
        ...(row.fixed ? {
          fixed: row.length 
        } : {}),
        paddingTop: row.paddingTop,
        paddingBottom: row.paddingBottom,
      });
    }
    for (let c of arr.range(0, this.columnCount - 1)) {
      let col = this.grid.col(c);
      columns.push(c, {
        ...(col.fixed ? {
          fixed: col.length 
        } : {}),
        paddingLeft: col.paddingLeft,
        paddingRight: col.paddingRight,
      });
    }
    for (let cell of this.cellGroups) {
      if (cell.morph) {
        groups[cell.morph.name] = obj.select(cell, ['align', 'resize']);
      }
    }
    return { autoAssign: false, grid, rows, columns, groups }
  }

  // serialize as expression with the config
  __serialize__() {
    return {
      __expr__: `new GridLayout(${JSON.stringify(this.getSpec())})`,
      bindings: {"lively.morphic": ["GridLayout"]}
    }
  }

  initGrid() {
    const grid = this.ensureGrid(this.config),
          rows = grid.map(row => new LayoutRow(new LayoutCell({row, layout: this})));
    rows.reduce((a, b) => a.attachTo(b));
    this.config.autoAssign && this.autoAssign(this.notInLayout);
    this.grid = rows[0].col(0);
    this.col(0).equalizeDynamicAxis();
    this.row(0).equalizeDynamicAxis();
    this.initRowsAndColumns();
    this.initGroups();
  }

  initGroups() {
    const {groups} = this.config;
    if (groups) {
      for (let g in groups) {
        let group = this.getCellGroupFor(this.container.getSubmorphNamed(g)),
            {resize, align = 'topLeft', alignedProperty = 'topLeft'} = groups[g];
        if (!group) continue;
        if (resize != undefined) group.resize = resize
        group.align = align;
        group.alignedProperty = alignedProperty;
      }
    }
  }

  initRowsAndColumns() {
    const {rows = [], columns = []} = this.config;
    for (var [idx, props] of arr.toTuples(rows, 2)) {
      Object.assign(this.row(idx), props);
    }
    for (var [idx, props] of arr.toTuples(columns, 2)) {
      Object.assign(this.col(idx), props);
    }
  }

  get compensateOrigin() { return this.config.compensateOrigin; }
  set compensateOrigin(compensate) { this.config.compensateOrigin = compensate; this.apply() }

  get fitToCell() { return this.config.fitToCell }
  set fitToCell(fit) {
     this.config.fitToCell = fit;
     this.cellGroups.forEach(g => g.resize = fit);
     this.apply()
  }

  get notInLayout() {
    return arr.withoutAll(
      this.layoutableSubmorphs,
      this.cellGroups.map(g => g.morph));
  }

  col(idx) { return this.grid.col(idx) }
  row(idx) { return this.grid.row(idx) }

  get rowCount() { return this.grid.col(0).items.length }
  get columnCount() { return this.grid.row(0).items.length }

  addGroup(group) {
    this.cellGroups.push(group);
  }

  removeGroup(group) {
    arr.remove(this.cellGroups, group);
  }

  fitAxis() {
    var totalStaticHeight,
        totalStaticWidth,
        dynamicHeight = this.grid.dynamicHeight,
        dynamicWidth = this.grid.dynamicWidth;
    [this.grid.row(0), ...this.grid.row(0).axisAfter].map(r => {
      r.prepareForResize(this.container.height);
      totalStaticHeight = this.grid.totalStaticHeight;
      return r;
    }).forEach(r => {
      if (!r.fixed) r.length = r.proportion * Math.max(0, this.container.height - totalStaticHeight)
    });
    [this.grid.col(0), ...this.grid.col(0).axisAfter].map(c => {
      c.prepareForResize(this.container.width);
      totalStaticWidth = this.grid.totalStaticWidth;
      return c;
    }).forEach(c => {
      if (!c.fixed) c.length = c.proportion * Math.max(0, this.container.width - totalStaticWidth)
    });
  }

  apply(animate = false) {
    if (this.active) return;
    this.active = true;
    super.apply(animate);
    if (!this.grid) this.initGrid();
    // fit dynamic rows and cols
    this.fitAxis();
    this.container.extent = pt(Math.max(this.grid.totalStaticWidth, this.container.width),
                               Math.max(this.grid.totalStaticHeight, this.container.height));
    this.fitAxis();
    this.cellGroups.forEach(g => {
      g && g.apply(animate);
    });
    this.lastBoundsExtent = this.container.bounds().extent();
    this.active = false;
  }

  get submorphBoundsChanged() {
    for (let g of this.cellGroups) {
      if (g.morph && !g.bounds().equals(g.morph.bounds())) {
        return true;
      }
    }
    return false;
  }

  getCellGroupFor(morph) {
    return morph && this.cellGroups.find(g => g.morph == morph);
  }

  onSubmorphRemoved(removedMorph) {
    const cellGroup = this.getCellGroupFor(removedMorph);
    if (cellGroup) cellGroup.morph = null;
    super.onSubmorphRemoved(removedMorph);
  }

  inspect(pointerId) {
    return new GridLayoutHalo(this.container, pointerId);
  }

  ensureGrid({grid, rowCount, columnCount}) {
    grid = grid || [[]];
    rowCount =  rowCount || grid.length;
    columnCount = columnCount || arr.max(grid.map(row => row.length));

    if (grid.length < rowCount) {
      grid = grid.concat(arr.withN(rowCount - grid.length, []));
    }

    grid = grid.map(row => {
      if (row.length < columnCount)
        row = row.concat(arr.withN(columnCount - row.length, null));
      return row.map(v => {
        if (v && v.isMorph) {
          if (v.owner != this.container) this.container.addMorph(v);
          return v;
        }
        if (v) return this.container.getSubmorphNamed(v) || v;
        return v;
      })
    });
    return grid;
  }

  autoAssign(morphs) {
    morphs.forEach(m => {
      var cellGroup, closestDist = Infinity;
      this.cellGroups.forEach(g => {
        if (!g.morph) {
          g.cells.forEach(c => {
            var distToCell = c.position.dist(m.position);
            if (distToCell < closestDist) {
               cellGroup = g
               closestDist = distToCell;
            }
          });
        }
      });
      if(cellGroup) cellGroup.morph = m;
    });
  }

}
