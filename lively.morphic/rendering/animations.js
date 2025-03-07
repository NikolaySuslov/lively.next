/*global SVG, System*/
import { obj, promise, fun, num, properties, arr, string } from "lively.lang";
import { Color } from "lively.graphics";
import {styleProps, addPathAttributes, addSvgAttributes} from "./property-dom-mapping.js";
import { interpolate as flubberInterpolate } from 'flubber';
import Bezier from 'bezier-easing';
import "web-animations-js";


/*rms 27.11.17: Taken from https://css-tricks.com/snippets/sass/easing-map-get-function/ */

export const easings = {
  inQuad:      'cubic-bezier(0.550,  0.085, 0.680, 0.530)',
  inCubic:     'cubic-bezier(0.550,  0.055, 0.675, 0.190)',
  inQuart:     'cubic-bezier(0.895,  0.030, 0.685, 0.220)',
  inQuint:     'cubic-bezier(0.755,  0.050, 0.855, 0.060)',
  inSine:      'cubic-bezier(0.470,  0.000, 0.745, 0.715)',
  inExpo:      'cubic-bezier(0.950,  0.050, 0.795, 0.035)',
  inCirc:      'cubic-bezier(0.600,  0.040, 0.980, 0.335)',
  inBack:      'cubic-bezier(0.600, -0.280, 0.735, 0.045)',
  outQuad:     'cubic-bezier(0.250,  0.460, 0.450, 0.940)',
  outCubic:    'cubic-bezier(0.215,  0.610, 0.355, 1.000)',
  outQuart:    'cubic-bezier(0.165,  0.840, 0.440, 1.000)',
  outQuint:    'cubic-bezier(0.230,  1.000, 0.320, 1.000)',
  outSine:     'cubic-bezier(0.390,  0.575, 0.565, 1.000)',
  outExpo:     'cubic-bezier(0.190,  1.000, 0.220, 1.000)',
  outCirc:     'cubic-bezier(0.075,  0.820, 0.165, 1.000)',
  outBack:     'cubic-bezier(0.175,  0.885, 0.320, 1.275)',
  inOutQuad:   'cubic-bezier(0.455,  0.030, 0.515, 0.955)',
  inOutCubic:  'cubic-bezier(0.645,  0.045, 0.355, 1.000)',
  inOutQuart:  'cubic-bezier(0.770,  0.000, 0.175, 1.000)',
  inOutQuint:  'cubic-bezier(0.860,  0.000, 0.070, 1.000)',
  inOutSine:   'cubic-bezier(0.445,  0.050, 0.550, 0.950)',
  inOutExpo:   'cubic-bezier(1.000,  0.000, 0.000, 1.000)',
  inOutCirc:   'cubic-bezier(0.785,  0.135, 0.150, 0.860)',
  inOutBack:   'cubic-bezier(0.680, -0.550, 0.265, 1.550)',
  linear:      'cubic-bezier(0.5, 0.5, 0.5, 0.5)'
}

function convertToSvgEasing(easing) {
  for (let k in easings) {
    if (easings[k] !== easing) continue;
    if (k.includes('inOut')) return k.replace('inOut', '').toLowerCase() + 'InOut';
    if (k.includes('out')) return k.replace('out', '').toLowerCase() + 'Out';
    if (k.includes('in')) return k.replace('in', '').toLowerCase() + 'In';
  }
}

export function stringToEasing(easingString) {
  return obj.isFunction(easingString) ? easingString : Bezier(...eval(`([${easingString.match(/\((.*)\)/)[1]}])`));
}

export class AnimationQueue {
  constructor(morph) {
    this.morph = morph;
    this.animations = [];
  }

  maskedProps(type) {
    const l = this.animations.length;
    return l > 0 ? obj.merge(this.animations.map(a => a.getAnimationProps(type)[0])) : {};
  }

  get animationsActive() {
    return true;
  }

  registerAnimation(config) {
    const anim = new PropertyAnimation(this, this.morph, config);
    this.morph.makeDirty();
    return this.morph.withMetaDo({animation: anim}, () => {
      let existing = anim.affectsMorph && this.animations.find(a => a.equals(anim));
      if (!existing) {
        let mergeable;
        if (mergeable = this.animations.find(a => a.canMerge(anim))) {
          mergeable.mergeWith(anim);
          return mergeable;
        } else if (anim.affectsMorph) {
          anim.assignProps();
          this.animations.push(anim);
          return anim; 
        }
      }
      return existing;
    });
  }

  startAnimationsFor(node) {
    for (let i = 0; i < this.animations.length; i++) {
      let anim = this.animations[i];
      anim.start(node);
    }
  }
  startSvgAnimationsFor(svgNode, type) {
    this.animations.forEach(anim => anim.startSvg(svgNode, type));
  }

  removeAnimation(animation) {
    arr.remove(this.animations, animation);
  }
}

export class PropertyAnimation {
  
  constructor(queue, morph, config) {
    this.queue = queue;
    this.morph = morph;
    if (morph.isPath && config.fill) {
        const fillBefore = morph.fill, fillAfter = config.fill;
        config.customTween = fun.compose(p => {
          morph.fill = fillBefore.interpolate(p, fillAfter);
          return p;
       }, config.customTween || (p => {}));
       delete config.fill;
       morph.fill = fillBefore;
    }
    this.config = this.convertBounds(config);
    this.needsAnimation = {
      svg: morph.isSvgMorph,
      path: morph.isPath,
      // polygon: morph.isPolygon
    };
    this.capturedProperties = obj.select(this.morph, this.propsToCapture);
  }

  get propsToCapture() {
    return ["fill", "origin"];
  }

  asPromise() {
    return this._promise || (this._promise = new Promise((resolve, reject) => {
      this.resolveCallback = () => {
        this.onFinish(this);
        if (this.subAnimations) {
          this.subAnimations.then(resolve);
        } else {
          resolve(this.morph);
        }
      };
    }));
  }

  finish(type) {
    if (this.config.scale) {
      // when we have been performing a scale animation,
      // there is a possibility that some of the text morphs
      // inside the submorph hierarchy have been measureing their
      // line heights incorrectly
      this.morph.whenRendered().then(() => 
          this.morph.withAllSubmorphsDo(m => m.isText && m.invalidateTextLayout(true, true)));
    }
    this.needsAnimation[type] = false;
    if (!arr.any(obj.values(this.needsAnimation), Boolean)) {
      this.queue.removeAnimation(this);
      this.resolveCallback ? this.resolveCallback() : this.onFinish();
    }
  }

  convertBounds(config) {
    var {bounds, origin, rotation, scale, layout, fill} = config,
        origin = origin || this.morph.origin,
        rotation = rotation || this.morph.rotation,
        scale = scale || this.morph.scale;
    if (bounds) {
      return {
        ...obj.dissoc(config, ["bounds"]),
        origin,
        rotation,
        scale,
        position: bounds.topLeft().addPt(origin),
        extent: bounds.extent()
      };
    } else {
      return config;
    }
  }

  equals(animation) {
    return obj.equals(this.animatedProps, animation.animatedProps);
  }

  canMerge(animation) {
    return this.easing == animation.easing && this.duration == animation.duration;
  }

  mergeWith(animation) {
    let origCustomTween = this.config.customTween,
        customTween = (p) => {
      origCustomTween && origCustomTween(p);
      animation.customTween && animation.config.customTween(p);
    }
    Object.assign(this.morph, animation.animatedProps);
    Object.assign(this.config, animation.config);
    this.config.customTween = customTween;
    this.afterProps = this.gatherAnimationProps();
  }

  get affectsMorph() {
    return !!this.config.customTween || properties.any(
      this.animatedProps,
      (animatedProps, prop) => !obj.equals(animatedProps[prop], this.morph[prop])
    );
  }

  get animatedProps() {
    return obj.dissoc(this.config, ["customTween", "easing", "onFinish", "duration"]);
  }

  get easing() {
    return this.config.easing || easings.inOutQuad;
  }
  get onFinish() {
    return this.config.onFinish || (() => {});
  }
  setonFinish(cb) {
    this.config.onFinish = cb;
  }
  get duration() {
    return this.config.duration || 1000;
  }

  getChangedProps(before, after) {
    const unchangedProps = [];
    for (var prop in before) {
      if (obj.equals(after[prop], before[prop])) {
        unchangedProps.push(prop);
      }
    }
    return [obj.dissoc(before, unchangedProps), obj.dissoc(after, unchangedProps)];
  }

  getAnimationProps(type) {
    let [before, after] = this.getChangedProps(this.beforeProps[type], this.afterProps[type]),
        {fill: fillBefore, dropShadow: shadowBefore} = this.capturedProperties,
        {fill: fillAfter, dropShadow: shadowAfter} = this.config;
    if (this.morph.isPolygon && type == 'css') {
      fillBefore = fillAfter = false;
      delete before['background'];
      delete after['background'];
      delete before['backgroundImage'];
      delete after['backgroundImage'];
    }
    if (before.filter == 'none' && after.boxShadow) {
      delete before.filter;
      before.boxShadow = 'none';
    }
    if (after.filter == 'none' && before.boxShadow) {
      delete after.filter;
      after.boxShadow = 'none';
    }
    if (fillBefore && fillAfter && (fillBefore.isGradient || fillAfter.isGradient)) {
      this.tweenGradient = this.interpolate('gradient', fillBefore, fillAfter); 
    }
    // ensure that before and after props both have the same keys
    for (let key of arr.union(obj.keys(before), obj.keys(after))) {
      if (!key in before) before[key] = after[key];
      if (!key in after) after[key] = before[key];
    }
    return [obj.isEmpty(before) ? false : before, obj.isEmpty(after) ? false : after];
  }

  gatherAnimationProps() {
    let {morph} = this,
        {isSvgMorph, isPath, isPolygon} = morph,
        props = {};
    props.css = styleProps(this.morph);
    if (isSvgMorph) props.svg = addSvgAttributes(morph, {});
    if (isPath) props.path = addPathAttributes(morph, {});
    if (isPolygon) props.polygon = addPathAttributes(morph, {});
    return props;
  }

  assignProps() {
    const styleClassesBefore = this.morph.styleClasses;
    this.beforeProps = this.gatherAnimationProps();
    Object.assign(this.morph, this.animatedProps);
    this.afterProps = this.gatherAnimationProps();
    if (this.config.styleClasses) { 
      this.morph._animatedStyleClasses = { 
        removed: arr.withoutAll(styleClassesBefore, this.morph.styleClasses),
        added: arr.withoutAll(this.morph.styleClasses, styleClassesBefore),
        animation: this
      };
    }
  }

  interpolate(attr, v1, v2) {
    switch (attr) {
       case "scrollTop":
       case "scrollLeft":
         return i => num.interpolate(i, v1, v2);
       case 'd':
         return flubberInterpolate(v1, v2);
       case 'stroke-width':
         return i => num.interpolate(i, v1, v2);
       case 'stroke':
        return i => Color.fromString(v1).interpolate(i, Color.fromString(v2), this.morph.bounds());
       case 'gradient':
        return i => v1.interpolate(i, v2, this.morph.bounds());
       case 'fill':
         v1 = Color.fromString(v1);
         v2 = Color.fromString(v2);
         return i => v1.interpolate(i, v2);
    }
  }

  startSvg(svgNode, type) {
    if (this.needsAnimation[type]) {
      this.needsAnimation[type] = false;
      const [before, after] = this.getAnimationProps(type),
            params = {},
            easingFn = stringToEasing(this.easing);
      for (let k in before) params[k] = this.interpolate(k, before[k], after[k]);
      let startTime,
          draw = (time) => {
          var t;
          if (!startTime) {
            startTime = time;
          }
          t = time - startTime;
          // Next iteration 
          if (t / this.duration > 1) return this.finish(type);
          for (let k in params) {
             if (!params[k]) continue;
             svgNode.setAttribute(k, params[k](easingFn(t / this.duration))) 
          }
          requestAnimationFrame(draw);
        }
      requestAnimationFrame(draw);
    }
  }

  start(node) {
    if (!this.active) {
      this.active = true;
      let [before, after] = this.getAnimationProps("css");
      this.tween(node, before, after);
      if (this.config.origin) {
        let b = this.capturedProperties.origin,
            a = this.config.origin,
            originNode = node.childNodes[0];
        this.tween(
          originNode,
          originNode.style.top ? { left: `${b.x}px`, top: `${b.y}px` } : {
            transform: `translate3d(${b.x}px, ${b.y}px, 0px)`
          },
          originNode.style.top ? { left: `${b.x}px`, top: `${b.y}px` } : {
            transform: `translate3d(${a.x}px, ${a.y}px, 0px)`
          }
        );
      }
    }
  }

  tween(node, before, after, remove = true) {
    let scroll = this.animatedProps.scroll,
        customTween = this.config.customTween,
        removalScheduled = false;
    let onComplete = () => {
      if (!remove) return;
      this.finish('css');
      this.morph.makeDirty();
    };
    if (customTween) {
        let startTime,
           easingFn = stringToEasing(this.easing),
           draw = (time) => {
          var t, p;
          if (!startTime) {
            startTime = time;
          }
          t = time - startTime;
          p = Math.min(1, t / this.duration);
          // Next iteration 
          this.morph.dontRecordChangesWhile(() =>
             customTween(easingFn(p)));
          if (p >= 1) return this.finish('css');
          requestAnimationFrame(draw);
        }
        requestAnimationFrame(draw);
        removalScheduled = true;
    }
    if (scroll) {
       // perform own custom scroll animation, just like
       // we perfrom custom path transform animation
       // also perform custom gradient interpolation if we morph
       // across gradient fills with this custom method      
       let startTime,
           scrollState = this.morph.env.eventDispatcher.eventState,
           { promise: p, resolve } = promise.deferred(),
           interpolateScrollX = this.interpolate('scrollLeft', node.scrollTop, scroll.x),
           interpolateScrollY = this.interpolate('scrollTop', node.scrollTop, scroll.y),
           easingFn = stringToEasing(this.easing),
           draw = (time) => {
          var t, x;
          if (!startTime) {
            startTime = time;
          }
          t = time - startTime;
          x = Math.min(1, t / this.duration);
          // Next iteration
          node.scrollTop = interpolateScrollY(easingFn(x));
          node.scrollLeft = interpolateScrollX(easingFn(x)); 
          if (t / this.duration >= 1) {
            scrollState.scroll.interactiveScrollInProgress = null;
            resolve();
            return this.finish('css');
          }
          requestAnimationFrame(draw);
        }
        p.debounce = () => {};
        requestAnimationFrame(draw);
        removalScheduled = true;
    }
    if (this.tweenGradient && !this.morph.isPolygon) {
      let startTime,
          easingFn = stringToEasing(this.easing),
          draw = (time) => {
          var t;
          if (!startTime) {
            startTime = time;
          }
          t = time - startTime;
          // Next iteration 
          if (t / this.duration >= 1) return this.finish('css');
          node.style.setProperty('background-image', this.tweenGradient(easingFn(t / this.duration)));
          requestAnimationFrame(draw);
        }
        delete before.backgroundImage;
        delete after.backgroundImage;
        delete before.background;
        delete after.background;
        requestAnimationFrame(draw);
        removalScheduled = true;
    } else if (this.tweenGradient) {
      removalScheduled = true;
    }
    if (node && before && after) {
      let camelBefore = {},
          camelAfter = {};
      for (let k in before) camelBefore[string.camelize(k)] = before[k];
      for (let k in after) camelAfter[string.camelize(k)] = after[k];
      try {
        let anim = node.animate([camelBefore, camelAfter], {
          duration: this.duration,
          easing: this.easing,
          fill: "forwards",
          composite: "replace"
        });
        anim.onfinish = () => {
          onComplete();
          setTimeout(() => anim.cancel(), 200);
        };
        removalScheduled = true;
      } catch (e) {
        removalScheduled = false;
      }
    }
    if (!removalScheduled) onComplete();
  }
}
