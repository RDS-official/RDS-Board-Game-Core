import * as THREE from 'three';
import { VisualTraceEvent } from '@rds/kernel/types';
import { BoardGameAudio } from './audio';

export interface ActiveTween {
  update: (progress: number) => void;
  onComplete?: () => void;
  startTime: number;
  duration: number;
}

export class TransactionalAnimationQueue {
  private queue: VisualTraceEvent[] = [];
  private isProcessing: boolean = false;
  private activeTweens: ActiveTween[] = [];
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private onEventStartCallback?: (event: VisualTraceEvent) => void;
  private onQueueDrainedCallback?: () => void;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
  }

  public enqueue(events: VisualTraceEvent[]): void {
    this.queue.push(...events);
    if (!this.isProcessing) {
      this.processNext();
    }
  }

  public onEventStart(cb: (event: VisualTraceEvent) => void): void {
    this.onEventStartCallback = cb;
  }

  public onQueueDrained(cb: () => void): void {
    this.onQueueDrainedCallback = cb;
  }

  public update(): void {
    const now = performance.now();
    for (let i = this.activeTweens.length - 1; i >= 0; i--) {
      const tween = this.activeTweens[i];
      const elapsed = now - tween.startTime;
      const progress = Math.min(1, Math.max(0, elapsed / tween.duration));

      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      tween.update(eased);

      if (progress >= 1) {
        if (tween.onComplete) tween.onComplete();
        this.activeTweens.splice(i, 1);
      }
    }
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      if (this.onQueueDrainedCallback) this.onQueueDrainedCallback();
      return;
    }

    this.isProcessing = true;
    const event = this.queue.shift()!;

    if (this.onEventStartCallback) {
      this.onEventStartCallback(event);
    }

    // Play appropriate sound & trigger visual effect
    switch (event.type) {
      case 'CARD_DRAW':
      case 'CARD_PLAY':
      case 'CARD_DISCARD':
        BoardGameAudio.playCardDraw();
        break;

      case 'DICE_ROLL':
        BoardGameAudio.playDiceRoll();
        break;

      case 'TOKEN_TRANSFER':
        BoardGameAudio.playChipClink();
        break;

      case 'BUILD_OBJECT':
        BoardGameAudio.playBuild();
        break;

      case 'RULE_MUTATE':
        BoardGameAudio.playHauntAlarm();
        this.triggerScreenShake(event.durationMs || 800);
        break;

      case 'DAMAGE_EFFECT':
        this.triggerScreenShake(300);
        break;

      case 'ANNOUNCEMENT':
        if (event.title.includes('HU!') || event.title.includes('Winner')) {
          BoardGameAudio.playVictoryFanfare();
        }
        break;
    }

    // Await duration before next transaction
    const duration = Math.min(event.durationMs || 300, 600);
    await new Promise(resolve => setTimeout(resolve, duration));

    this.processNext();
  }

  /**
   * Camera screen shake effect for damage / haunt
   */
  private triggerScreenShake(durationMs: number = 400): void {
    const originalPos = this.camera.position.clone();
    const startTime = performance.now();

    const shakeTween: ActiveTween = {
      startTime,
      duration: durationMs,
      update: (p) => {
        const intensity = (1 - p) * 0.18;
        this.camera.position.set(
          originalPos.x + (Math.random() - 0.5) * intensity,
          originalPos.y + (Math.random() - 0.5) * intensity,
          originalPos.z + (Math.random() - 0.5) * intensity
        );
      },
      onComplete: () => {
        this.camera.position.copy(originalPos);
      }
    };

    this.activeTweens.push(shakeTween);
  }

  /**
   * Parabolic arc animation for moving objects
   */
  public animateArc(
    object: THREE.Object3D,
    from: THREE.Vector3,
    to: THREE.Vector3,
    peakHeight: number = 2.5,
    durationMs: number = 500,
    onFinish?: () => void,
    delayMs: number = 0
  ): void {
    this.animate(
      durationMs,
      p => {
        // Linear interpolation X & Z
        object.position.x = THREE.MathUtils.lerp(from.x, to.x, p);
        object.position.z = THREE.MathUtils.lerp(from.z, to.z, p);
        // Parabolic arc for Y
        const arc = 4 * peakHeight * p * (1 - p);
        object.position.y = THREE.MathUtils.lerp(from.y, to.y, p) + arc;
      },
      onFinish,
      delayMs
    );
  }

  /**
   * Generic tween. `delayMs` parks the object at its start state until the
   * delay elapses (progress stays clamped at 0), which is how staggered deals
   * and chip flights are sequenced without timers.
   */
  public animate(
    durationMs: number,
    update: (progress: number) => void,
    onComplete?: () => void,
    delayMs = 0
  ): void {
    this.activeTweens.push({
      startTime: performance.now() + Math.max(0, delayMs),
      duration: Math.max(1, durationMs),
      update,
      onComplete
    });
  }
}
