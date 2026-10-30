/**
 * Web Audio API Sound & Dynamic Music Engine.
 * Pure procedural audio synthesis for authentic atmospheric horror and tactile tabletop feedback.
 * Zero external audio files required — 100% offline and deterministic!
 */

export type AmbientSoundscape =
  | 'SILENT'
  | 'EXPLORATION_GROUND'
  | 'EXPLORATION_BASEMENT'
  | 'EXPLORATION_UPPER'
  | 'HAUNT_MUMMY'
  | 'HAUNT_EYE'
  | 'HAUNT_PHANTOM'
  | 'HAUNT_ZOMBIE'
  | 'HAUNT_WEREWOLF';

export class BoardGameAudio {
  private static ctx: AudioContext | null = null;
  private static enabled: boolean = true;
  private static masterGain: GainNode | null = null;
  private static ambientGain: GainNode | null = null;
  private static sfxGain: GainNode | null = null;

  // Active ambient generators
  private static currentSoundscape: AmbientSoundscape = 'SILENT';
  private static ambientNodes: { stop: () => void }[] = [];
  private static ambientTimer: number | null = null;

  private static getContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();

        // Master Gain hierarchy: master -> [ambientGain, sfxGain] -> destination
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.85, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);

        this.ambientGain = this.ctx.createGain();
        this.ambientGain.gain.setValueAtTime(0.45, this.ctx.currentTime);
        this.ambientGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
        this.sfxGain.connect(this.masterGain);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public static toggleSound(enabled?: boolean): boolean {
    this.enabled = enabled !== undefined ? enabled : !this.enabled;
    if (!this.enabled) {
      this.stopSoundscape();
    }
    return this.enabled;
  }

  public static isSoundEnabled(): boolean {
    return this.enabled;
  }

  public static setMasterVolume(val: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, val)), this.ctx.currentTime);
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Dynamic Atmospheric Ambient Soundscapes                                    */
  /* -------------------------------------------------------------------------- */

  public static setSoundscape(mode: AmbientSoundscape): void {
    if (!this.enabled) return;
    if (this.currentSoundscape === mode) return;
    this.currentSoundscape = mode;

    const ctx = this.getContext();
    if (!ctx || !this.ambientGain) return;

    // Cross-fade out existing ambient nodes over 1.2s
    const oldNodes = [...this.ambientNodes];
    this.ambientNodes = [];
    if (this.ambientTimer !== null) {
      window.clearInterval(this.ambientTimer);
      this.ambientTimer = null;
    }

    if (oldNodes.length > 0) {
      const fadeGain = ctx.createGain();
      fadeGain.gain.setValueAtTime(1, ctx.currentTime);
      fadeGain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 1.2);
      oldNodes.forEach(node => { node.stop(); });
    }

    if (mode === 'SILENT') return;

    // Spin up new soundscape
    switch (mode) {
      case 'EXPLORATION_GROUND':
        this.startGroundAmbience(ctx);
        break;
      case 'EXPLORATION_BASEMENT':
        this.startBasementAmbience(ctx);
        break;
      case 'EXPLORATION_UPPER':
        this.startUpperAmbience(ctx);
        break;
      case 'HAUNT_MUMMY':
        this.startMummyMusic(ctx);
        break;
      case 'HAUNT_EYE':
        this.startEyeMusic(ctx);
        break;
      case 'HAUNT_PHANTOM':
        this.startPhantomMusic(ctx);
        break;
      case 'HAUNT_ZOMBIE':
        this.startZombieMusic(ctx);
        break;
      case 'HAUNT_WEREWOLF':
        this.startWerewolfMusic(ctx);
        break;
    }
  }

  public static stopSoundscape(): void {
    this.currentSoundscape = 'SILENT';
    if (this.ambientTimer !== null) {
      window.clearInterval(this.ambientTimer);
      this.ambientTimer = null;
    }
    this.ambientNodes.forEach(n => { n.stop(); });
    this.ambientNodes = [];
  }

  /**
   * Ground Floor: Gentle distant howling wind outside foggy windows,
   * subtle creaking floorboards, and a quiet Victorian grandfather clock tick.
   */
  private static startGroundAmbience(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    // 1. Distant wind noise
    const windBuffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const windData = windBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < windBuffer.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // Pink noise
      windData[i] = last * 3.5;
    }

    const windSource = ctx.createBufferSource();
    windSource.buffer = windBuffer;
    windSource.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.setValueAtTime(320, ctx.currentTime);

    const windGain = ctx.createGain();
    windGain.gain.setValueAtTime(0.08, ctx.currentTime);

    windSource.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambientGain);
    windSource.start();

    // 2. Grandfather clock ticking (1 second interval: tick... tock...)
    let clockTock = false;
    const clockInterval = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'EXPLORATION_GROUND') return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(clockTock ? 640 : 880, ctx.currentTime);
      gain.gain.setValueAtTime(0.035, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
      osc.connect(gain);
      if (this.ambientGain) gain.connect(this.ambientGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
      clockTock = !clockTock;
    }, 1000);

    this.ambientTimer = clockInterval;
    this.ambientNodes.push({
      stop: () => {
        try {
          windSource.stop();
          windSource.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Basement: Subterranean resonant low rumble (45-55 Hz sub-bass drone)
   * with cavernous dark reverberation and echoing water droplets.
   */
  private static startBasementAmbience(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    // Sub-bass resonant drone
    const drone1 = ctx.createOscillator();
    const drone2 = ctx.createOscillator();
    const droneGain = ctx.createGain();

    drone1.type = 'sine';
    drone1.frequency.setValueAtTime(48, ctx.currentTime); // Low G0
    drone2.type = 'sine';
    drone2.frequency.setValueAtTime(52.5, ctx.currentTime); // 4.5 Hz slow beat note

    droneGain.gain.setValueAtTime(0.18, ctx.currentTime);

    drone1.connect(droneGain);
    drone2.connect(droneGain);
    droneGain.connect(this.ambientGain);
    drone1.start();
    drone2.start();

    // Echoing water droplets at random intervals (every 2-4 seconds)
    const dripInterval = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'EXPLORATION_BASEMENT') return;
      this.playWaterDrip();
    }, 2800);

    this.ambientTimer = dripInterval;
    this.ambientNodes.push({
      stop: () => {
        try {
          drone1.stop();
          drone2.stop();
          drone1.disconnect();
          drone2.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Upper Floor: Gusting whistling drafts through wooden slats,
   * creaking rafters, and distant high eerie harmonics.
   */
  private static startUpperAmbience(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, ctx.currentTime);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(450, ctx.currentTime);
    filter.Q.setValueAtTime(4.0, ctx.currentTime);

    // Subtle LFO for wind gust sweeping
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(0.18, ctx.currentTime); // 0.18 Hz slow sweep
    lfoGain.gain.setValueAtTime(180, ctx.currentTime);
    lfo.connect(filter.frequency);
    lfo.start();

    gain.gain.setValueAtTime(0.07, ctx.currentTime);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientGain);
    osc.start();

    this.ambientNodes.push({
      stop: () => {
        try {
          osc.stop();
          lfo.stop();
          osc.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Haunt #1: The Mummy Walks (Ancient tomb ritual percussion & Phrygian drone).
   */
  private static startMummyMusic(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    // Phrygian drone (E2 / F2 / B2)
    const d1 = ctx.createOscillator();
    const d2 = ctx.createOscillator();
    const gain = ctx.createGain();
    d1.type = 'triangle';
    d1.frequency.setValueAtTime(82.4, ctx.currentTime); // E2
    d2.type = 'sawtooth';
    d2.frequency.setValueAtTime(87.3, ctx.currentTime); // F2 (Phrygian minor 2nd clash)

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(260, ctx.currentTime);

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    d1.connect(filter);
    d2.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientGain);
    d1.start();
    d2.start();

    // Rhythmic ritual tomb pulse (deep heartbeat drum every 1.1s)
    const drumTimer = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'HAUNT_MUMMY') return;
      this.playRitualDrum(ctx);
    }, 1100);

    this.ambientTimer = drumTimer;
    this.ambientNodes.push({
      stop: () => {
        try {
          d1.stop();
          d2.stop();
          d1.disconnect();
          d2.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Haunt #6: The Floating Eye (Cosmic horror, theremin oscillations, psychic alien pulses).
   */
  private static startEyeMusic(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    const theremin = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const gain = ctx.createGain();

    theremin.type = 'sine';
    theremin.frequency.setValueAtTime(280, ctx.currentTime);

    // Vibrato LFO
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(5.5, ctx.currentTime);
    lfoGain.gain.setValueAtTime(24, ctx.currentTime);
    lfo.connect(theremin.frequency);
    lfo.start();

    gain.gain.setValueAtTime(0.12, ctx.currentTime);

    theremin.connect(gain);
    gain.connect(this.ambientGain);
    theremin.start();

    // Slow cosmic pitch glides
    let high = true;
    const glideTimer = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'HAUNT_EYE') return;
      theremin.frequency.exponentialRampToValueAtTime(high ? 420 : 210, ctx.currentTime + 2.5);
      high = !high;
    }, 3200);

    this.ambientTimer = glideTimer;
    this.ambientNodes.push({
      stop: () => {
        try {
          theremin.stop();
          lfo.stop();
          theremin.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Haunt #10: The Phantom's Embrace (Ghostly sorrow, shivering frost wind, mournful pads).
   */
  private static startPhantomMusic(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    // Sorrowful minor string pad
    const p1 = ctx.createOscillator();
    const p2 = ctx.createOscillator();
    const pGain = ctx.createGain();

    p1.type = 'triangle';
    p1.frequency.setValueAtTime(220, ctx.currentTime); // A3
    p2.type = 'sine';
    p2.frequency.setValueAtTime(261.63, ctx.currentTime); // C4 (minor third)

    pGain.gain.setValueAtTime(0.12, ctx.currentTime);
    p1.connect(pGain);
    p2.connect(pGain);
    pGain.connect(this.ambientGain);
    p1.start();
    p2.start();

    // Shivering tremolo
    const trem = ctx.createOscillator();
    const tremGain = ctx.createGain();
    trem.frequency.setValueAtTime(6.0, ctx.currentTime);
    tremGain.gain.setValueAtTime(0.04, ctx.currentTime);
    trem.connect(pGain.gain);
    trem.start();

    this.ambientNodes.push({
      stop: () => {
        try {
          p1.stop();
          p2.stop();
          trem.stop();
          p1.disconnect();
          p2.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Haunt #3: Living Dead / Zombie (Funeral bell cadence, shuffling corpses, doom choir).
   */
  private static startZombieMusic(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    const drone = ctx.createOscillator();
    drone.type = 'sawtooth';
    drone.frequency.setValueAtTime(65.4, ctx.currentTime); // Low C2
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(160, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, ctx.currentTime);

    drone.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientGain);
    drone.start();

    // Slow distant funeral bell tolling every 4 seconds
    const bellTimer = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'HAUNT_ZOMBIE') return;
      this.playFuneralBell(ctx);
    }, 4000);

    this.ambientTimer = bellTimer;
    this.ambientNodes.push({
      stop: () => {
        try {
          drone.stop();
          drone.disconnect();
        } catch {}
      }
    });
  }

  /**
   * Haunt #5: The Werewolf (Adrenaline heartbeat at 120 BPM, tense predatory breathing).
   */
  private static startWerewolfMusic(ctx: AudioContext): void {
    if (!this.ambientGain) return;

    // Rapid dual-thud heartbeat (lub-dub) every 0.5s
    let beatPhase = 0;
    const heartTimer = window.setInterval(() => {
      if (!this.enabled || this.currentSoundscape !== 'HAUNT_WEREWOLF') return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(beatPhase === 0 ? 55 : 45, ctx.currentTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      if (this.ambientGain) gain.connect(this.ambientGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);

      beatPhase = (beatPhase + 1) % 2;
    }, 250);

    this.ambientTimer = heartTimer;
  }

  /* -------------------------------------------------------------------------- */
  /* Tactile Board Game Action SFX                                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Footsteps on creaky wood floorboards or damp basement stone.
   */
  public static playFootstep(floor?: string): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const isStone = floor === 'BASEMENT';
    if (isStone) {
      // Dull stone slap + cave resonance
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(140 + Math.random() * 30, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.09);

      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);

      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.10);
    } else {
      // Creaky antique timber floorboard step
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const pitch = 220 + Math.random() * 50;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(pitch, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(pitch * 0.8, ctx.currentTime + 0.08);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(500, ctx.currentTime);
      filter.Q.setValueAtTime(3.0, ctx.currentTime);

      gain.gain.setValueAtTime(0.14, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
    }
  }

  /**
   * Heavy wooden door latch click & rusty iron hinge creak (exploring a new room).
   */
  public static playDoorOpen(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    // 1. Mechanical latch click
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = 'triangle';
    click.frequency.setValueAtTime(1800, ctx.currentTime);
    clickGain.gain.setValueAtTime(0.2, ctx.currentTime);
    clickGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    click.connect(clickGain);
    clickGain.connect(this.sfxGain);
    click.start();
    click.stop(ctx.currentTime + 0.035);

    // 2. Creaking rusted hinge
    const creak = ctx.createOscillator();
    const creakGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    creak.type = 'sawtooth';
    creak.frequency.setValueAtTime(260, ctx.currentTime + 0.03);
    creak.frequency.linearRampToValueAtTime(420, ctx.currentTime + 0.22);
    creak.frequency.linearRampToValueAtTime(210, ctx.currentTime + 0.38);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.Q.setValueAtTime(4.0, ctx.currentTime);

    creakGain.gain.setValueAtTime(0.001, ctx.currentTime);
    creakGain.gain.setValueAtTime(0.18, ctx.currentTime + 0.04);
    creakGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.38);

    creak.connect(filter);
    filter.connect(creakGain);
    creakGain.connect(this.sfxGain);
    creak.start(ctx.currentTime + 0.03);
    creak.stop(ctx.currentTime + 0.40);
  }

  /**
   * Massive room tile placement thud and settling rumble.
   */
  public static playTilePlacement(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + 0.25);

    gain.gain.setValueAtTime(0.45, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.26);

    osc.connect(gain);
    gain.connect(this.sfxGain);

    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  }

  /**
   * Snappy card slide / draw
   */
  public static playCardDraw(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const bufferSize = ctx.sampleRate * 0.12;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.03));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.12);
    filter.Q.setValueAtTime(2.0, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);

    noise.start();
  }

  /**
   * Crisp card flip snap
   */
  public static playCardFlip(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.05);

    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  }

  /**
   * Soft paper discard swish
   */
  public static playCardDiscard(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const bufferSize = ctx.sampleRate * 0.15;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.05));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    noise.start();
  }

  /**
   * Bone dice tumbling & rolling on wooden tabletop
   */
  public static playDiceRoll(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const hitTimes = [0, 0.06, 0.13, 0.21, 0.30, 0.42];
    hitTimes.forEach((delay, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const pitch = 240 + Math.random() * 120 - idx * 18;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(pitch, ctx.currentTime + delay);
      osc.frequency.exponentialRampToValueAtTime(pitch * 0.55, ctx.currentTime + delay + 0.05);

      gain.gain.setValueAtTime(0.25 / (idx + 1), ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.05);

      osc.connect(gain);
      gain.connect(this.sfxGain!);

      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.06);
    });
  }

  /**
   * Antique brass clink & leather satchel rustle when picking up items
   */
  public static playItemPickup(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    // Brass key clink
    [2400, 3600].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.03);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + idx * 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.03 + 0.1);
      osc.connect(gain);
      gain.connect(this.sfxGain!);
      osc.start(ctx.currentTime + idx * 0.03);
      osc.stop(ctx.currentTime + idx * 0.03 + 0.11);
    });
  }

  /**
   * Heavy item drop onto floor
   */
  public static playItemDrop(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  }

  /**
   * Specialized item usage SFX (weapon slash, gunshot, bell, potion, mystic)
   */
  public static playItemUse(kind: 'weapon' | 'gun' | 'bell' | 'potion' | 'mystic' | 'torch' | string = 'weapon'): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    if (kind === 'gun' || kind.includes('revolver') || kind.includes('gun')) {
      // Explosive gunshot crack and reverberation
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.06));
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.65, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      noise.connect(gain);
      gain.connect(this.sfxGain);
      noise.start();
    } else if (kind === 'bell' || kind.includes('bell')) {
      // Resonant brass bell toll with rich overtone decay
      [440, 880, 1320, 1760].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.25 / (idx + 1), ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2 - idx * 0.2);
        osc.connect(gain);
        gain.connect(this.sfxGain!);
        osc.start();
        osc.stop(ctx.currentTime + 1.3);
      });
    } else if (kind === 'potion' || kind.includes('serum') || kind.includes('medical')) {
      // Glass uncork + drink swallow
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(540, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } else if (kind === 'mystic' || kind.includes('crystal') || kind.includes('board')) {
      // Shimmering celestial sine sweep
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1040, ctx.currentTime + 0.35);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.36);
    } else {
      // Metallic blade slash / weapon strike
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(950, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.16);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1200, ctx.currentTime);

      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.17);
    }
  }

  /**
   * Combat impact & damage groans
   */
  public static playCombat(kind: 'PHYSICAL' | 'MENTAL' = 'PHYSICAL', hit: boolean = true): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    if (kind === 'MENTAL') {
      // Psychic dissonance screech and ringing
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1400, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(350, ctx.currentTime + 0.3);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.31);
    } else {
      // Heavy physical punch / slash impact
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(hit ? 160 : 280, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.18);

      gain.gain.setValueAtTime(hit ? 0.45 : 0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(this.sfxGain);
      osc.start();
      osc.stop(ctx.currentTime + 0.19);
    }
  }

  /**
   * Eerie gothic low drone + thunder when Haunt triggers
   */
  public static playHauntAlarm(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    // Discordant brass organ drone
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(65.4, ctx.currentTime); // C2
    osc1.frequency.linearRampToValueAtTime(55, ctx.currentTime + 1.8);

    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(69.3, ctx.currentTime); // C#2 (severe dread dissonance)
    osc2.frequency.linearRampToValueAtTime(58.5, ctx.currentTime + 1.8);

    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.42, ctx.currentTime + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.2);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.sfxGain);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 2.3);
    osc2.stop(ctx.currentTime + 2.3);

    // Deep thunder roll
    this.playThunder();
  }

  /**
   * Distant rolling thunder
   */
  public static playThunder(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const buffer = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < buffer.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.45));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(140, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);
    noise.start();
  }

  /**
   * Ceramic chip / gem clink (Splendor)
   */
  public static playChipClink(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    [3200, 4800, 6400].forEach(f => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.sfxGain!);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    });
  }

  /**
   * Construction placement thud (Catan)
   */
  public static playBuild(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  }

  /**
   * Gothic victory chime
   */
  public static playVictoryFanfare(): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + idx * 0.12;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.25, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);

      osc.connect(gain);
      gain.connect(this.sfxGain!);
      osc.start(start);
      osc.stop(start + 0.45);
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Internal soundscape generators                                             */
  /* -------------------------------------------------------------------------- */

  private static playWaterDrip(): void {
    const ctx = this.getContext();
    if (!ctx || !this.ambientGain) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const f = 1200 + Math.random() * 400;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(f * 1.5, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(this.ambientGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  }

  private static playRitualDrum(ctx: AudioContext): void {
    if (!this.ambientGain) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(this.ambientGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.23);
  }

  /* ---------------------------------------------------------------------- */
  /* Room / story reactive accents                                           */
  /* ---------------------------------------------------------------------- */

  /** A short room-specific motif, played when the active room changes. */
  public static playRoomAccent(roomId: string, roomName = '', tags: string[] = []): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;
    let hash = 2166136261;
    for (const char of `${roomId}|${roomName}|${tags.join(',')}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const key = `${roomId} ${roomName} ${tags.join(' ')}`.toLowerCase();
    const base = 180 + (hash % 160);
    const notes = /(地下室|地下平台|catacombs|furnace|熔炉)/.test(key)
      ? [base * 0.5, base * 0.75, base * 1.12]
      : /(图书|书房|library|study)/.test(key)
        ? [base * 1.5, base * 1.25, base * 1.0]
        : /(舞厅|ballroom|音乐|music)/.test(key)
          ? [base * 2, base * 1.5, base * 1.25]
          : [base, base * 1.18, base * 1.4];

    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + 0.04 + index * 0.16;
      osc.type = index === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.001, at);
      gain.gain.exponentialRampToValueAtTime(0.05 / (index + 1), at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.8 + index * 0.2);
      osc.connect(gain);
      gain.connect(this.sfxGain!);
      osc.start(at);
      osc.stop(at + 1.1 + index * 0.2);
    });

    // Furnace / kitchen rooms get a dry mechanical tick under the motif.
    if (/(熔炉|厨房|furnace|kitchen)/.test(key)) {
      const tick = ctx.createOscillator();
      const tickGain = ctx.createGain();
      tick.type = 'square';
      tick.frequency.setValueAtTime(68, ctx.currentTime + 0.55);
      tickGain.gain.setValueAtTime(0.03, ctx.currentTime + 0.55);
      tickGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
      tick.connect(tickGain);
      tickGain.connect(this.sfxGain);
      tick.start(ctx.currentTime + 0.55);
      tick.stop(ctx.currentTime + 0.72);
    }
  }

  /** Story/event stinger driven by the event card or announcement title. */
  public static playEventStinger(title: string): void {
    const ctx = this.getContext();
    if (!ctx || !this.sfxGain) return;
    const text = title.toLowerCase();
    const dread = /(血|骨|鬼|魂|眼|尸|诅咒|黑暗|坠落|崩塌|死亡|haunt|blood|skull|ghost|eye|death)/.test(text);
    const fire = /(火|燃烧|烟|炉|fire|burn|smoke)/.test(text);
    const wind = /(风|雾|寒|冷|wind|fog|cold|frost)/.test(text);
    const base = dread ? 52 : fire ? 74 : wind ? 96 : 120;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = dread ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(base, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(base * 0.6, ctx.currentTime + 0.7);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
    osc.connect(gain);
    gain.connect(this.sfxGain);
    osc.start();
    osc.stop(ctx.currentTime + 0.95);

    if (dread || fire) {
      const high = ctx.createOscillator();
      const highGain = ctx.createGain();
      high.type = 'triangle';
      high.frequency.setValueAtTime(fire ? 740 : 466, ctx.currentTime + 0.08);
      highGain.gain.setValueAtTime(0.025, ctx.currentTime + 0.08);
      highGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.75);
      high.connect(highGain);
      highGain.connect(this.sfxGain);
      high.start(ctx.currentTime + 0.08);
      high.stop(ctx.currentTime + 0.78);
    }
  }

  private static playFuneralBell(ctx: AudioContext): void {
    if (!this.ambientGain) return;
    [220, 261.6, 330].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.12 / (idx + 1), ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);
      osc.connect(gain);
      gain.connect(this.ambientGain!);
      osc.start();
      osc.stop(ctx.currentTime + 1.9);
    });
  }
}
