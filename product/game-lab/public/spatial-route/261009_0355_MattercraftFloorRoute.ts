import { Behavior, ContextManager, isDesignTime, started, useOnAfterRender } from '@zcomponent/core';
import { Group } from '@zcomponent/three/lib/components/Group';
import { useCamera } from '@zcomponent/three/lib/scenecontext';
import { ImmersalAnchorGroup } from '@zcomponent/immersal/lib/components/ImmersalAnchorGroup';
import { WorldTracker } from '@zcomponent/zappar-three/lib/components/trackers/WorldTracker';
import * as Zappar from '@zappar/zappar';
import * as THREE from 'three';
import config from './261009_0355_route-example.json';
import { createMattercraftRoute } from './261009_0355_mattercraft-bridge.js';

export default class MattercraftFloorRoute extends Behavior<Group> {
  private route?: ReturnType<typeof createMattercraftRoute>;
  private onHidden = () => this.route?.pause();
  private onLeave = () => this.route?.pause();

  constructor(contextManager: ContextManager, instance: Group) {
    super(contextManager, instance);
    if (isDesignTime(contextManager)) return;
    started(contextManager).then(() => {
      if (this.disposed) return;
      const anchor = instance.parent;
      if (!(anchor instanceof ImmersalAnchorGroup) || !(anchor.parent instanceof WorldTracker)) throw new Error('WorldTracker 아래 Immersal 앵커, 그 아래 경로 그룹을 배치해 주세요.');
      this.route = createMattercraftRoute({
        THREE, anchor, routeSpace: instance, worldTracker: anchor.parent, config,
        getCamera: () => useCamera(contextManager).value,
        trackingStatus: Zappar.AnchorStatus.ANCHOR_STATUS_TRACKING,
        goodQuality: Zappar.WorldTrackerQuality.WORLD_TRACKER_QUALITY_GOOD,
        onStatus: detail => { window.dispatchEvent(new CustomEvent('nonol:spatial-route-status', { detail })); },
        onComplete: detail => { window.dispatchEvent(new CustomEvent('nonol:spatial-route-complete', { detail })); }
      });
      this.register(useOnAfterRender(contextManager), () => { if (document.hidden) this.route?.pause(); else this.route?.tick(); });
      document.addEventListener('visibilitychange', this.onHidden);
      window.addEventListener('pagehide', this.onLeave);
    }).catch(() => { if (!this.disposed) window.dispatchEvent(new CustomEvent('nonol:spatial-route-status', { detail: { state: 'setup-required' } })); });
  }

  resetRoute() { this.route?.reset(); }

  dispose() {
    document.removeEventListener('visibilitychange', this.onHidden);
    window.removeEventListener('pagehide', this.onLeave);
    this.route?.dispose();
    return super.dispose();
  }
}

export function attachMattercraftFloorRoute(contextManager: ContextManager, instance: Group) {
  const behavior = new MattercraftFloorRoute(contextManager, instance);
  instance.addBehavior(behavior);
  return behavior;
}
