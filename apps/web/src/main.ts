import { GAME_REGISTRY } from '@rds/games/registry';

/** 玩家可控文本进入 innerHTML 前的转义（审查报告 S4）。 */
const escText = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
import { BoardGameScene, CameraPreset } from './render/scene';
import { BoardGameAudio } from './render/audio';
import { ensureCanvasFontsReady } from './render/fonts';
import { checkWebGLSupport, renderWebGLErrorModal } from './render/webglSupport';
import { hideGameLoading } from './gameLoading';
import { BoardGameHUD } from './ui/hud';
import { installDiagnostics } from './diagnostics/install';
import { MathematicalInspectorUI } from './ui/mathInspector';
import { CameraView, GameSnapshot, PresentationPorts } from '@rds/app/contracts';
import { layoutForGame } from '@rds/app/layout';
import { NetSession, NetSessionOptions } from '@rds/app/netSession';
import { UniversalSession } from '@rds/app/session';
import type { InteractiveObjectData } from './render/raycaster';

/**
 * Composition root only.
 * Wires: kernel session (application) ↔ presenter contract ↔ UI / renderer.
 * No game rules or UI state live here.
 */
class BoardGameSimulatorApp {
  private readonly scene: BoardGameScene;
  private session: UniversalSession | NetSession;
  /** Set when URL params request a hub-backed lobby session. */
  private readonly netOptions?: NetSessionOptions;
  private readonly hud: BoardGameHUD;
  private readonly inspector: MathematicalInspectorUI;
  private readonly ports: PresentationPorts;

  private currentGameId = 'catan';
  private lastRevision = -1;
  private lastPlacementKey = '';
  /** Net sessions: show the game-over overlay exactly once per session. */
  private netGameOverShown = false;
  /** Local sessions: same guard, so the end-of-game overlay appears once. */
  private localGameOverShown = false;
  /** Scenario the current session started from, so "再来一局" can replay it. */
  private activeScenario?: string;
  private lastRoomId = '';
  private freeDragEntityId?: string;
  private readonly initialScenario?: string;
  /** True once the canvas webfont can be used; gates the first board paint. */
  private fontsReady = false;
  private pendingSnapshot?: GameSnapshot;

  constructor() {
    const canvasContainer = document.getElementById('canvas-container')!;
    const hudContainer = document.getElementById('hud-container')!;
    const inspectorContainer = document.getElementById('inspector-container')!;

    const params = new URLSearchParams(window.location.search);
    this.initialScenario = params.get('scenario') ?? undefined;
    this.activeScenario = this.initialScenario;
    this.currentGameId = params.get('game') ?? 'catan';
    this.netOptions = parseNetSessionOptions(params);

    this.scene = new BoardGameScene(canvasContainer);
    this.session = this.createSession(this.currentGameId, this.initialScenario);

    this.ports = {
      setCamera: (view: CameraView) => this.scene.setCameraPreset(this.cameraPreset(view)),
      setSound: (enabled: boolean) => {
        BoardGameAudio.toggleSound(enabled);
      },
      isSoundOn: () => BoardGameAudio.isSoundEnabled(),
      toggleInspector: () => this.toggleInspector(),
      highlightBoard: (ids: string[] | null) => this.scene.setHighlight(ids),
      focusRoom: (nodeId: string) => {
        this.scene.focusNode(nodeId);
      },
      clearRoomFocus: () => this.scene.clearFocus(),
      setFloor: (floorId: string) => {
        this.scene.focusFloor(floorId);
        this.hud.setSelectedFloor(floorId);
      },
      showTraitChange: change => {
        const tone = change.delta < 0 ? (change.damageKind === 'MENTAL' ? 'mental' : 'physical') : 'heal';
        const sign = change.delta > 0 ? '+' : '';
        this.scene.popTraitBurst(
          change.playerId,
          `${change.traitLabel} ${sign}${change.delta}`,
          tone
        );
        if (tone === 'heal') BoardGameAudio.playItemPickup();
        else BoardGameAudio.playCombat(tone === 'mental' ? 'MENTAL' : 'PHYSICAL', true);
      }
    };

    this.hud = new BoardGameHUD(hudContainer, this.session, this.ports, {
      onSwitchGame: gameId => this.switchGame(gameId),
      onSwitchScenario: scenarioId => this.restartScenario(scenarioId)
    });

    this.inspector = new MathematicalInspectorUI(inspectorContainer, this.session, {
      onClose: () => this.hud.setInspectorActive(false)
    });

    // 阶段二：联机对局顶栏「退出对局」——房主退出=结束全局（关房+全员回大厅），房客退出=仅自己离开，对局继续。
    if (this.netOptions) {
      const exitBtn = document.getElementById('btn-exit-net');
      if (exitBtn) exitBtn.hidden = false;
      exitBtn?.addEventListener('click', async () => {
        const opts = this.netOptions!;
        const isHost = opts.role === 'host';
        const msg = isHost ? '确定结束对局吗？全员将被送回大厅。' : '确定退出对局吗？对局将继续进行。';
        if (!window.confirm(msg)) return;
        try { (this.session as NetSession).dispose?.(); } catch { /* 尽力断开 */ }
        if (isHost) {
          try {
            await fetch('/api/rooms/' + opts.roomId + '/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.token },
              body: JSON.stringify({ status: 'closed' })
            });
          } catch { /* 关房失败也允许返回，大厅轮询兑底 */ }
        }
        location.href = location.pathname;
      });
    }

    document.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      const floor = target?.closest<HTMLElement>('[data-floor]')?.dataset.floor;
      if (floor) {
        this.scene.focusFloor(floor);
        this.hud.setSelectedFloor(floor);
      }
      const roomEl = target?.closest<HTMLElement>('[data-room-id]');
      const roomId = roomEl?.dataset.roomId;
      if (roomId && this.currentGameId === 'betrayal') {
        this.scene.focusNode(roomId);
        this.session.pickTarget({ kind: 'node', id: roomId });
      }
    });
    this.scene.onInteractiveClick(data => {
      // Clicking a room entity is also the inspection camera gesture: the
      // dossier and the 2.5D close-up should come from the same click.
      if (data.type === 'NODE' && data.metadata?.floor && this.currentGameId === 'betrayal') {
        this.scene.focusNode(data.id);
      }
      this.handleBoardPick(data);
    });
    this.scene.onInteractiveHover(data => {
      if (!data) {
        this.hud.showHoverHint(null);
        return;
      }
      const meta = (data.metadata ?? {}) as Record<string, unknown>;
      if (data.type === 'NODE') {
        if (meta?.type === 'ROOM_NAV') {
          const targetName = String(meta.targetName ?? meta.name ?? '相邻房间');
          this.hud.showHoverHint({
            title: `→ 进入【${targetName}】`,
            detail: '点击地上高亮箭头直接走入该房间（消耗 1 步）'
          });
          return;
        }
        if (meta?.type === 'DOOR') {
          this.hud.showHoverHint({
            title: `${String(meta.name ?? '门位')} · 探索未开启的门`,
            detail: '点击地上高亮箭头开启并抽取新房间'
          });
          return;
        }
        if (typeof meta.name === 'string') {
          this.hud.showHoverHint({
            title: String(meta.name),
            detail: '点击查看房间档案与陈设'
          });
          return;
        }
      }
      if (data.type === 'ENTITY') {
        const cardFace = meta as { title?: string; imageUrl?: string };
        if (cardFace.title) {
          // The imported card artwork travels with the raycast metadata, so the
          // hover preview can show the real face instead of a text stub.
          const art = typeof cardFace.imageUrl === 'string' ? cardFace.imageUrl : undefined;
          this.hud.showHoverHint({
            title: String(cardFace.title),
            detail: '点击查看卡牌详情',
            art
          });
          return;
        }
      }
      if (data.type === 'DICE') {
        this.hud.showHoverHint({ title: '骰子', detail: '点击掷骰' });
        return;
      }
      this.hud.showHoverHint(null);
    });
    this.scene.onEntityDrop((entityId, target, clientX, clientY) => {
      if (target?.type === 'ENTITY' && target.id !== entityId) {
        if (this.scene.canMergeCards(entityId, target.id)) {
          this.scene.mergeCardsVisually(entityId, target.id);
          this.scene.settleCard(entityId);
          this.hud.pushToast('▣', '已合入同类型牌堆（仅本视图）');
        } else {
          this.scene.resetCardDrag(entityId);
          this.hud.pushToast('⚠️', '不兼容的牌堆，已回弹');
        }
        this.freeDragEntityId = undefined;
        this.scene.clearDropTargets();
        return;
      }
      if (target?.type === 'NODE') {
        const result = this.session.placeEntityAtNode(entityId, target.id);
        if (result.ok) {
          this.freeDragEntityId = undefined;
          this.scene.clearDropTargets();
          return;
        }
      }
      this.scene.moveCardToScreen(entityId, clientX, clientY);
      this.freeDragEntityId = undefined;
      this.scene.clearDropTargets();
      this.hud.pushToast('↔', '卡牌位置已调整（仅本视图）');
    });
    this.scene.onEntityDragStart(entityId => {
      const targets = this.session.getPlacementTargets(entityId);
      const entity = this.session.getSnapshot().board.entities[entityId];
      this.freeDragEntityId = targets.length === 0 && entity?.type === 'CARD' ? entityId : undefined;
      this.scene.setDropTargets(targets.map(target => target.nodeId));
    });
    this.scene.onEntityDragEnd(() => {
      this.freeDragEntityId = undefined;
      this.scene.clearDropTargets();
    });
    this.bindSession(this.session);
    this.session.onVisualEvent(events => {
      this.scene.enqueueAnimations(events);
      for (const ev of events) {
        if (ev.type === 'EXPLORE_ROOM') {
          BoardGameAudio.playDoorOpen();
        } else if (ev.type === 'CARD_DRAW') {
          BoardGameAudio.playCardDraw();
          BoardGameAudio.playEventStinger(ev.title);
        } else if (ev.type === 'CARD_DISCARD') {
          BoardGameAudio.playCardDiscard();
        } else if (ev.type === 'DICE_ROLL') {
          BoardGameAudio.playDiceRoll();
        } else if (ev.type === 'DAMAGE_EFFECT') {
          const kind = ev.payload?.kind === 'MENTAL' ? 'MENTAL' : 'PHYSICAL';
          BoardGameAudio.playCombat(kind, true);
        } else if (ev.type === 'CARD_PLAY') {
          BoardGameAudio.playCardFlip();
        } else if (ev.type === 'BUILD_OBJECT') {
          BoardGameAudio.playBuild();
        } else if (ev.type === 'TOKEN_TRANSFER') {
          BoardGameAudio.playChipClink();
        } else if (ev.type === 'STACK_PUSH' || ev.type === 'STACK_POP' || ev.type === 'STACK_CANCEL') {
          BoardGameAudio.playCardFlip();
        } else if (ev.type === 'DECISION_REVEAL' || ev.type === 'STACK_TIMEOUT') {
          BoardGameAudio.playThunder();
        } else if (ev.type === 'RULE_MUTATE') {
          BoardGameAudio.playHauntAlarm();
          BoardGameAudio.playEventStinger(ev.title);
        } else if (ev.type === 'ANNOUNCEMENT') {
          BoardGameAudio.playEventStinger(ev.title);
        } else if (ev.type === 'MOVE_OBJECT') {
          BoardGameAudio.playFootstep();
        }
      }
    });
    const bootSnapshot = this.session.getSnapshot();
    // Canvas compares glyphs against the loaded face: painting the board before
    // the CJK webfont decodes would bake fallback glyphs into the tile/card
    // texture caches, which are never rebuilt.
    this.pendingSnapshot = bootSnapshot;
    void ensureCanvasFontsReady().then(() => {
      this.fontsReady = true;
      const snapshot = this.pendingSnapshot ?? this.session.getSnapshot();
      this.pendingSnapshot = undefined;
      this.lastRevision = snapshot.revision;
      this.lastPlacementKey = snapshot.placement
        ? `${snapshot.placement.defId}:${snapshot.placement.rotation}`
        : '';
      this.scene.syncState(snapshot.board, snapshot.placement, layoutForGame(this.currentGameId));
      // 首帧桌面已可绘制：撤掉开局加载遮罩（若存在）
      hideGameLoading();
    });
    // 兜底：字体探测异常卡死时也别把遮罩留成黑屏
    setTimeout(hideGameLoading, 15000);

    this.wireBootScreen();
    this.wireKeyboard();

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__boardGameApp = this;
    }
  }

  // 阶段三：联机状态遮罩（房客单独重连 / 房主暂离等待）。
  private netWaitEl: HTMLElement | null = null;
  private hostWaitTimer: number | null = null;

  private showNetWait(title: string, sub: string): void {
    if (!this.netWaitEl) {
      const el = document.createElement('div');
      el.id = 'net-wait';
      const s = el.style;
      s.position = 'fixed'; s.inset = '0'; s.zIndex = '9998';
      s.display = 'flex'; s.flexDirection = 'column'; s.alignItems = 'center'; s.justifyContent = 'center';
      s.gap = '12px'; s.background = 'rgba(13,17,23,.94)'; s.color = '#d9b45b';
      s.fontFamily = '"Alibaba PuHuiTi", system-ui, sans-serif';
      el.innerHTML = [
        '<div class="nw-title" style="font-size:20px;letter-spacing:2px"></div>',
        '<div class="nw-sub" style="font-size:13px;color:#8b949e"></div>'
      ].join('');
      document.body.appendChild(el);
      this.netWaitEl = el;
    }
    (this.netWaitEl.querySelector('.nw-title') as HTMLElement).textContent = title;
    (this.netWaitEl.querySelector('.nw-sub') as HTMLElement).textContent = sub;
  }

  private hideNetWait(): void {
    this.netWaitEl?.remove();
    this.netWaitEl = null;
  }

  /** 房主暂离：guest 侧 5 分钟倒计时遮罩，超时直接结束对局回大厅（m02676 定案）。 */
  private startHostWait(): void {
    if (this.hostWaitTimer !== null) return;
    const deadline = Date.now() + 5 * 60 * 1000;
    const tick = (): void => {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.stopHostWait();
        this.showNetWait('对局已结束', '房主超时未归，正在返回大厅…');
        setTimeout(() => { location.href = location.pathname; }, 1500);
        return;
      }
      const mm = String(Math.floor(left / 60000)).padStart(2, '0');
      const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      this.showNetWait('房主暂离', '等待房主返回… 剩余 ' + mm + ':' + ss);
    };
    tick();
    this.hostWaitTimer = window.setInterval(tick, 1000);
  }

  private stopHostWait(): void {
    if (this.hostWaitTimer !== null) {
      clearInterval(this.hostWaitTimer);
      this.hostWaitTimer = null;
    }
    this.hideNetWait();
  }

  private createSession(gameId: string, scenario?: string): UniversalSession | NetSession {
    const module = GAME_REGISTRY[gameId];
    if (!module) throw new Error(`Unknown game module: ${gameId}`);
    if (this.netOptions) {
      const net = new NetSession(module, this.netOptions);
      const opts = this.netOptions;
      const centreMode = net.authority === 'server';
      // 阶段二：presence → HUD 在线点。
      // P2P 模式额外把「房主座位离线」变成等待遮罩；中心模式没有房主权威，
      // 房主掉线不影响对局，因此不进入等待态。
      const hostPid = !centreMode && opts.role === 'guest'
        ? (Object.entries(opts.seatOwners ?? {}) as [string, string][])
            .find(([, uid]) => uid === opts.hostId)?.[0]
        : undefined;
      net.onPresence = ids => {
        this.hud?.setOnlinePlayers(ids);
        if (hostPid && !ids.includes(hostPid)) this.startHostWait();
        else this.stopHostWait();
      };
      // 断线重连遮罩（中心模式重连服务器，P2P 重连房主浏览器）。
      net.onGuestReconnecting = attempt => {
        this.showNetWait(
          '连接已断开',
          (centreMode ? '正在重新连接对局服务器…' : '正在重新连接房主…') + '（第 ' + attempt + ' 次尝试）'
        );
      };
      net.onGuestReconnected = () => {
        if (this.hostWaitTimer === null) this.hideNetWait();
        this.hud?.showAnnouncement('已重新连接');
      };
      net.onRoomClosed = () => {
        this.hud?.showAnnouncement('对局已结束');
        setTimeout(() => { location.href = location.pathname; }, 1200);
      };
      // Async connect; failures surface as onNotice toasts, not boot crashes.
      void net.start();
      return net;
    }
    return new UniversalSession(module, 42, scenario);
  }

  private bindSession(session: UniversalSession | NetSession): void {
    session.subscribe(snapshot => {
      // Hold every paint until the webfont is usable; the boot promise flushes
      // the newest snapshot it finds.
      if (!this.fontsReady) {
        this.pendingSnapshot = snapshot;
        return;
      }
      const placementKey = snapshot.placement
        ? `${snapshot.placement.defId}:${snapshot.placement.rotation}`
        : '';
      // Every kernel transition (including viewer projection changes) bumps the
      // revision. Rotation-only placement previews do not.
      if (snapshot.revision !== this.lastRevision || placementKey !== this.lastPlacementKey) {
        this.lastRevision = snapshot.revision;
        this.lastPlacementKey = placementKey;
        this.scene.setHighlight(null, false);
        this.scene.syncState(snapshot.board, snapshot.placement, layoutForGame(this.currentGameId));
      }

      // Dynamic situational ambient soundscape & music update
      if (this.currentGameId === 'betrayal') {
        const floor = snapshot.spatial?.activeFloor || 'GROUND';
        const haunt = snapshot.board.globalVars.haunt as { id: string } | null | undefined;
        if (haunt) {
          if (haunt.id === 'mummy') BoardGameAudio.setSoundscape('HAUNT_MUMMY');
          else if (haunt.id === 'floating_eye') BoardGameAudio.setSoundscape('HAUNT_EYE');
          else if (haunt.id === 'phantom') BoardGameAudio.setSoundscape('HAUNT_PHANTOM');
          else if (haunt.id === 'living_dead') BoardGameAudio.setSoundscape('HAUNT_ZOMBIE');
          else if (haunt.id === 'werewolf') BoardGameAudio.setSoundscape('HAUNT_WEREWOLF');
        } else {
          if (floor === 'BASEMENT') BoardGameAudio.setSoundscape('EXPLORATION_BASEMENT');
          else if (floor === 'UPPER') BoardGameAudio.setSoundscape('EXPLORATION_UPPER');
          else BoardGameAudio.setSoundscape('EXPLORATION_GROUND');
        }
      } else {
        BoardGameAudio.stopSoundscape();
        this.lastRoomId = '';
      }

      if (this.currentGameId === 'betrayal') {
        const focusId = snapshot.focus[0] ?? snapshot.viewer;
        const player = snapshot.board.players[focusId];
        const npc = snapshot.board.npcs?.[focusId];
        const roomId = String(
          player?.customProps?.currentRoomId ?? npc?.customProps?.roomId ?? ''
        );
        if (roomId && roomId !== this.lastRoomId) {
          this.lastRoomId = roomId;
          const node = snapshot.board.mapGraph.nodes[roomId];
          BoardGameAudio.playRoomAccent(
            roomId,
            String(node?.props?.name ?? ''),
            Array.isArray(node?.props?.tags) ? node.props.tags.map(String) : []
          );
        }
      }

      // Lobby lifecycle (Phase A): a finished net game offers a path back to the
      // lobby; the host also reopens the room so the table returns to 准备态.
      if (snapshot.gameOver && this.netOptions && !this.netGameOverShown) {
        this.netGameOverShown = true;
        showNetGameOverOverlay(this.netOptions);
      }

      // Local sessions used to end with nothing but an empty action dock, which
      // reads like a hang. Announce the outcome and offer a replay.
      if (snapshot.gameOver && !this.netOptions && !this.localGameOverShown) {
        this.localGameOverShown = true;
        this.showLocalGameOverOverlay(snapshot);
      }
    });
  }

  /** End-of-game card for single-machine play: winner, reason, replay. */
  private showLocalGameOverOverlay(snapshot: GameSnapshot): void {
    document.getElementById('local-gameover-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'local-gameover-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;background:rgba(13,17,23,.78)';

    const card = document.createElement('div');
    card.style.cssText =
      'min-width:320px;max-width:460px;background:#161d29;border:1px solid #2b3442;border-radius:12px;' +
      'padding:26px 32px;text-align:center;font-family:system-ui,sans-serif;color:#e6e1d5;' +
      'box-shadow:0 12px 48px rgba(0,0,0,.55)';

    const title = document.createElement('h2');
    title.textContent = '对局结束';
    title.style.cssText = 'margin:0 0 10px;color:#d9b45b;letter-spacing:1px;font-size:20px';

    const winner = document.createElement('p');
    winner.textContent = snapshot.winnerLabel ? `胜者：${snapshot.winnerLabel}` : '无人获胜';
    winner.style.cssText = 'margin:0 0 6px;font-size:15px;font-weight:600;color:#f0e4c4';

    const reason = document.createElement('p');
    reason.textContent = snapshot.winnerReason ?? '';
    reason.style.cssText = 'margin:0 0 14px;color:#8b94a3;font-size:13px;line-height:1.5';

    // Enumerate who is actually still standing, so "还有一个英雄存活吗" never
    // has to be guessed from dimmed cards.
    const alive = snapshot.players.filter(player => player.alive);
    const roster = document.createElement('div');
    roster.style.cssText = 'margin:0 0 18px;text-align:left;font-size:12px;line-height:1.7';
    roster.innerHTML =
      `<div style="color:#57ffa8">存活：${alive.length ? alive.map(p => `${p.avatar} ${escText(p.name)}`).join('、') : '无'}</div>` +
      `<div style="color:#8b94a3">已退场：${
        snapshot.players.filter(p => !p.alive).map(p => `${p.avatar} ${escText(p.name)}`).join('、') || '无'
      }</div>`;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center';

    const replay = document.createElement('button');
    replay.textContent = '↻ 再来一局';
    replay.style.cssText =
      'background:#d9b45b;color:#17130a;border:none;border-radius:6px;padding:9px 20px;' +
      'font-size:14px;font-weight:600;cursor:pointer';
    replay.addEventListener('click', () => {
      overlay.remove();
      this.localGameOverShown = false;
      this.restartScenario(this.activeScenario ?? '');
    });

    const close = document.createElement('button');
    close.textContent = '关闭';
    close.style.cssText =
      'background:transparent;color:#c9c1b1;border:1px solid #2b3442;border-radius:6px;' +
      'padding:9px 20px;font-size:14px;cursor:pointer';
    close.addEventListener('click', () => overlay.remove());

    row.append(replay, close);
    card.append(title, winner, reason, roster, row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private switchGame(gameId: string): void {
    if (gameId === this.currentGameId) return;
    // Lobby sessions are bound to the room's module; switching would strand
    // the peer mesh on a different game.
    if (this.netOptions) return;
    const module = GAME_REGISTRY[gameId];
    if (!module) return;

    this.session.dispose();
    this.currentGameId = gameId;
    this.activeScenario = undefined;
    this.localGameOverShown = false;
    document.getElementById('local-gameover-overlay')?.remove();
    this.session = this.createSession(gameId);

    this.scene.resetForNewGame();
    this.lastRevision = -1;
    this.lastPlacementKey = '';

    this.hud.setPresenter(this.session);
    this.inspector.setPresenter(this.session);
    this.bindSession(this.session);

    this.scene.setHighlight(null, false);
    const snapshot = this.session.getSnapshot();
    this.scene.syncState(snapshot.board, snapshot.placement, layoutForGame(gameId));
    this.lastRevision = snapshot.revision;
    this.lastPlacementKey = snapshot.placement ? `${snapshot.placement.defId}:${snapshot.placement.rotation}` : '';
    this.hud.syncCamera('iso');

    try {
      const url = new URL(window.location.href);
      url.searchParams.set('game', gameId);
      url.searchParams.delete('scenario');
      window.history.replaceState({}, '', url.toString());
      document.title = `${module.meta.name} · Universal Board Game Engine`;
    } catch {}

    this.hud.showAnnouncement(`已载入 · ${module.meta.name}`);
  }

  /**
   * Restart the current game at another starting position.
   *
   * Scenarios are setup functions, so switching one is a fresh session rather
   * than a state transition: same path as switching games, minus the game id.
   */
  private restartScenario(scenarioId: string): void {
    const module = GAME_REGISTRY[this.currentGameId];
    if (!module) return;
    const scenario = scenarioId === '' ? undefined : scenarioId;

    this.session.dispose();
    this.activeScenario = scenario;
    this.localGameOverShown = false;
    document.getElementById('local-gameover-overlay')?.remove();
    this.session = this.createSession(this.currentGameId, scenario);

    this.scene.resetForNewGame();
    this.lastRevision = -1;
    this.lastPlacementKey = '';

    this.hud.setPresenter(this.session);
    this.inspector.setPresenter(this.session);
    this.bindSession(this.session);

    this.scene.setHighlight(null, false);
    const snapshot = this.session.getSnapshot();
    this.scene.syncState(snapshot.board, snapshot.placement, layoutForGame(this.currentGameId));
    this.lastRevision = snapshot.revision;
    this.lastPlacementKey = snapshot.placement ? `${snapshot.placement.defId}:${snapshot.placement.rotation}` : '';
    this.hud.syncCamera('iso');

    try {
      const url = new URL(window.location.href);
      if (scenario) {
        url.searchParams.set('scenario', scenario);
      } else {
        url.searchParams.delete('scenario');
      }
      window.history.replaceState({}, '', url.toString());
    } catch {}

    const label = scenario ? String(module.scenarios?.[scenario]?.description ?? scenario) : '标准开局';
    this.hud.showAnnouncement(`剧本已重开 · ${label}`);
  }

  private toggleInspector(): void {
    this.inspector.toggleCollapse();
    this.hud.setInspectorActive(this.inspector.isOpen());
  }

  private cameraPreset(view: CameraView): CameraPreset {
    switch (view) {
      case 'top':
        return 'TOP_DOWN';
      case 'seat':
        return 'PLAYER_1';
      default:
        return 'ISOMETRIC';
    }
  }

  private handleBoardPick(data: InteractiveObjectData): void {
    const kind =
      data.type === 'NODE'
        ? 'node'
        : data.type === 'EDGE'
        ? 'edge'
        : data.type === 'DICE'
        ? 'dice'
        : 'entity';

    this.session.pickTarget({
      kind,
      id: data.id,
      metadata: { ...((data.metadata as object) || {}), intent: 'interact' }
    });
  }

  private wireBootScreen(): void {
    const boot = document.getElementById('boot-screen');
    const enter = document.getElementById('boot-enter');
    const commitEl = document.getElementById('boot-commit');
    if (commitEl && typeof __COMMIT_HASH__ !== 'undefined') {
      commitEl.textContent = `commit ${__COMMIT_HASH__}`;
    }
    enter?.addEventListener('click', () => {
      boot?.classList.add('hidden');
      this.hud.showAnnouncement('欢迎 · 点击底部动作栏开始推演');
    });
    // 联机会话：开局流程已由大厅完成（创建/就绪/等待），跳过欢迎页直达牌局
    if (this.netOptions) {
      boot?.classList.add('hidden');
      this.hud.showAnnouncement('联机对局 · 正在同步牌局状态…');
    }
  }

  private wireKeyboard(): void {
    window.addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.key === 'Escape') {
        this.hud.closePayload();
        this.hud.closeAbout();
        this.session.cancelPlacement();
        this.scene.setHighlight(null);
        return;
      }

      if (event.key === 'i' || event.key === 'I') {
        this.toggleInspector();
        return;
      }

      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const action = this.session.getSnapshot().actions[digit - 1];
        if (action) {
          this.hud.promptAction(action.id);
          event.preventDefault();
        }
      }
    });
  }
}

// 统一外壳下 main.ts 可能被 shell.ts 动态 import（此时 DOMContentLoaded 已触发）
function bootApp(): void {
  const check = checkWebGLSupport();
  if (!check.supported) {
    console.error('[RDS-Board] WebGL is not available:', check.error, check.detail);
    hideGameLoading();
    renderWebGLErrorModal(check.detail || check.error);
    return;
  }

  // 诊断日志先装好：之后任何异常（含启动失败）都能被记录与导出。
  const diagnostics = installDiagnostics({
    build: import.meta.env.VITE_BUILD_ID ?? 'dev',
    endpoint: '/api/diagnostics',
    stateSummary: () => {
      const app = (window as unknown as Record<string, unknown>).__boardGameApp as
        | { session?: { getSnapshot?: () => { revision?: number; gameId?: string; phaseLabel?: string; actorName?: string; actions?: unknown[] } } }
        | undefined;
      const snapshot = app?.session?.getSnapshot?.();
      if (!snapshot) return { note: 'session not ready' };
      return {
        gameId: snapshot.gameId,
        revision: snapshot.revision,
        phase: snapshot.phaseLabel,
        actor: snapshot.actorName,
        actionCount: snapshot.actions?.length ?? 0
      };
    }
  });
  window.addEventListener('beforeunload', () => diagnostics.log.push('info', 'lifecycle', '页面即将卸载'));

  try {
    new BoardGameSimulatorApp();
  } catch (err) {
    const errorMsg = (err as Error)?.message || String(err);
    if (errorMsg.includes('WebGL') || errorMsg.includes('THREE.WebGLRenderer')) {
      console.error('[RDS-Board] Failed to initialize WebGL renderer:', err);
      renderWebGLErrorModal(errorMsg);
    } else {
      throw err;
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}

/**
 * Lobby URL: ?hub=<origin>&roomId=<roomId>&token=<hubToken>&playerId=<playerId>
 * plus role=host|guest (契约名见 docs/LOBBY-INTEGRATION.md；旧别名
 * room/player/host 仍兼容). All four base params are required; anything less
 * falls back to the local single-player session.
 *
 * **中心模式（默认）**：`authority=server`（缺省）。服务器持有唯一权威引擎，
 * 房主与房客都只是客户端，座位由服务器按大厅玩家顺序下发，因此 `role` 与
 * `hostId` 不再影响权威位置，也不再需要 WebRTC 直连。
 * 传 `authority=p2p` 可回退到旧的「房主浏览器为权威」直连模式。
 */
function parseNetSessionOptions(params: URLSearchParams): NetSessionOptions | undefined {
  const hub = params.get('hub');
  const room = params.get('roomId') ?? params.get('room');
  const token = params.get('token');
  const player = params.get('playerId') ?? params.get('player');
  if (!hub || !room || !token || !player) return undefined;
  const role = params.get('role') === 'host' ? 'host' : 'guest';
  const authority: 'server' | 'p2p' = params.get('authority') === 'p2p' ? 'p2p' : 'server';
  const hostId = params.get('hostId') ?? params.get('host') ?? undefined;
  // 只有旧的 P2P 房客路径需要 hostId（要拨号到房主浏览器）；中心模式不需要。
  if (authority === 'p2p' && role === 'guest' && !hostId) {
    console.warn('[net-session] p2p guest role requires &host=<hostHubUserId>; falling back to local session');
    return undefined;
  }
  // 阶段一：座位 → hub 身份（JSON），房主开局时写进内核 Player 展示字段。
  let roster: NetSessionOptions['roster'];
  try {
    const raw = params.get('roster');
    if (raw) roster = JSON.parse(raw);
  } catch { /* 忽略坏 roster，退回内核默认名 */ }
  // 阶段二：座位 → hub userId（JSON），presence 反映射回玩家卡在线点。
  let seatOwners: NetSessionOptions['seatOwners'];
  try {
    const raw = params.get('owners');
    if (raw) seatOwners = JSON.parse(raw);
  } catch { /* 忽略坏 owners，在线点不显示 */ }
  return {
    hub,
    roomId: room,
    token,
    role,
    authority,
    playerId: player,
    hostId,
    scenario: params.get('scenario') ?? undefined,
    roster,
    seatOwners
  };
}

/**
 * Phase A 生命周期回流：网络对局结束后展示「返回大厅」浮层。
 * 房主负责把房间状态置回 open（大厅房间页随即显示等待中，可再开一局）；
 * 返回大厅 = 清掉 URL 网络参数整页重载，让统一外壳重新探测并回到大厅视图。
 */
function showNetGameOverOverlay(opts: NetSessionOptions): void {
  if (document.getElementById('net-gameover-overlay')) return;
  const isHost = opts.role === 'host';
  const overlay = document.createElement('div');
  overlay.id = 'net-gameover-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;background:rgba(13,17,23,.78)';
  const card = document.createElement('div');
  card.style.cssText = 'background:#161d29;border:1px solid #2b3442;border-radius:12px;padding:28px 36px;text-align:center;font-family:system-ui,sans-serif;color:#e6e1d5;box-shadow:0 12px 48px rgba(0,0,0,.55)';
  const title = document.createElement('h2');
  title.textContent = '对局结束';
  title.style.cssText = 'margin:0 0 8px;color:#d9b45b;letter-spacing:1px';
  const hint = document.createElement('p');
  hint.textContent = isHost
    ? '房间已恢复为等待中，回到大厅可邀请新朋友再开一局。'
    : '等待房主把房间恢复为等待中，回到大厅查看房间状态。';
  hint.style.cssText = 'margin:0 0 18px;color:#8b94a3;font-size:14px';
  const back = document.createElement('button');
  back.textContent = '⟵ 返回大厅';
  back.style.cssText = 'background:#d9b45b;color:#17130a;border:none;border-radius:6px;padding:10px 22px;font-size:15px;font-weight:600;cursor:pointer';
  back.addEventListener('click', async () => {
    back.disabled = true;
    if (isHost) {
      // 尽力而为：失败也允许返回（房间页轮询会看到 stale 状态）
      try {
        await fetch('/api/rooms/' + opts.roomId + '/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.token },
          body: JSON.stringify({ status: 'open' })
        });
      } catch { /* 返回大厅后房间轮询兜底 */ }
    }
    location.href = location.pathname;
  });
  card.append(title, hint, back);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}
