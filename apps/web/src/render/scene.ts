import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Entity, MapGraphNode, ProjectedGameState } from '@rds/kernel/types';
import { TransactionalAnimationQueue } from './animationQueue';
import { BoardRaycaster, InteractiveObjectData } from './raycaster';
import { CardMeshBuilder } from './procedural/cardMesh';
import { pokemonCardBackTexture, pokemonCardTexture } from './procedural/pokemonAssets';
import { PKMN_COLOR_TO_GEM } from '@rds/games/splendor/setup';
import { DiceMeshBuilder } from './procedural/diceMesh';
import { HexTileBuilder } from './procedural/hexTile';
import { RoomTileBuilder } from './procedural/roomTile';
import { TokenMeshBuilder } from './procedural/tokenMesh';
import { GameTableBuilder } from './table';
import { createDefaultProjectionRegistry, ProjectionRegistry } from './projectionPort';
import { LabelOverlay, WorldLabel } from './labels/labelOverlay';
import { ScreenRect } from './labels/labelLayout';
import { buildCardGroups } from './cardGroups';
import { cardGroupKey } from './cardGroups';
import { PresentationPhysics } from './physics';
import { BoardGameAudio } from './audio';
import { CANVAS_FONT_STACK } from './fonts';

export type CameraPreset = 'ISOMETRIC' | 'TOP_DOWN' | 'PLAYER_1' | 'PLAYER_2';

export interface PlacementPreview {
  name: string;
  position: [number, number, number];
  rotation: number;
  doors: string[];
  color: string;
  defId?: string;
  en?: string;
  floor?: string;
  col?: number;
  row?: number;
  symbol?: string;
  text?: string;
  special?: string;
  tags?: string[];
  fromRoomId?: string;
  entryDir?: string;
  connections?: {
    dir: 'N' | 'S' | 'E' | 'W' | string;
    dirZh: string;
    neighborRoomId?: string;
    neighborRoomName?: string;
    connected: boolean;
    status: 'connected' | 'blocked' | 'open';
  }[];
}

/** Presentation-only hints; the app layer supplies these, never core state. */
export interface LayoutHints {
  padding?: number;
  cameraDirection?: [number, number, number];
  minDistance?: number;
}

export interface RenderStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  lastSyncMs: number;
}

export class BoardGameScene {
  private static readonly _scratchNdc = new THREE.Vector2();
  private static readonly _scratchRaycaster = new THREE.Raycaster();
  private static readonly _scratchPoint = new THREE.Vector3();
  private static readonly _scratchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2);
  private static readonly _scratchRayOrigin = new THREE.Vector3();
  private static readonly _scratchRayDir = new THREE.Vector3(0, -1, 0);

  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster: BoardRaycaster;
  private animQueue: TransactionalAnimationQueue;
  private projection: ProjectionRegistry = createDefaultProjectionRegistry();
  private physics = new PresentationPhysics();
  private focusLight?: THREE.PointLight;
  private lastFrameTime = performance.now();
  private readonly labels: LabelOverlay;

  // Scene entities mapping: entityId -> THREE.Object3D
  private entityMeshes = new Map<string, THREE.Object3D>();
  private nodeMeshes = new Map<string, THREE.Object3D>();
  private edgeMeshes = new Map<string, THREE.Object3D>();

  private boardObjectsGroup = new THREE.Group();
  private dragTargetGroup = new THREE.Group();
  private isDestroyed = false;
  private lastRawState: ProjectedGameState | null = null;
  private lastState: ProjectedGameState | null = null;
  private lastPlacement?: PlacementPreview;
  private lastLayout?: LayoutHints;
  private lastFitSignature = '';
  private lastBoardKey = '';
  private prePlacementCamera?: { position: THREE.Vector3; target: THREE.Vector3 };
  /** Room the active actor occupied on the previous sync, for camera follow. */
  private lastActorRoomId?: string;
  /** Active actor on the previous sync, for tracking turn switches in GOD mode. */
  private lastActorId?: string;
  /** Floor currently isolated in the 3D scene ('ALL' shows every layer). */
  private visibleFloor = 'ALL';
  private cameraTween?: {
    fromPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPosition: THREE.Vector3;
    toTarget: THREE.Vector3;
    startedAt: number;
    duration: number;
  };
  private skipFitUntil = 0;
  private cameraTweenTimer?: number;
  private lastPreviewRotation?: number;
  private previewObjects: THREE.Object3D[] = [];
  private navArrowMeshes: {
    group: THREE.Object3D;
    material: THREE.MeshStandardMaterial;
    baseIntensity: number;
    baseY: number;
  }[] = [];
  private hasFitted = false;
  private lastSyncMs = 0;
  private hoveredEntityId?: string;
  private fanZoneId?: string;
  private cardVisualOffsets = new Map<string, { dx: number; dz: number }>();
  private groupMembers = new Map<string, string[]>();
  private groupDrag?: {
    groupId: string;
    startWorld: [number, number, number];
    bases: Map<string, [number, number, number]>;
    offsets: Map<string, { dx: number; dz: number }>;
  };
  private draggedEntityId?: string;
  private draggedEntityOrigin?: {
    position: [number, number, number];
    offset: { dx: number; dz: number };
  };
  private draggedHeldY?: number;
  private groupHeldY?: number;
  private cardSettles = new Map<
    string,
    { startY: number; targetY: number; startedAt: number; duration: number }
  >();
  private knownRoomIds = new Set<string>();
  private roomSettles = new Map<
    string,
    { startY: number; targetY: number; startedAt: number; duration: number }
  >();
  private highlightIds = new Set<string>();
  /**
   * Highlighted meshes mapped to the material they had before highlighting.
   *
   * The highlight works by swapping in a per-mesh clone rather than mutating the
   * material: room meshes share material instances, so tinting one tinted every
   * room that shared it and the restore then wrote stale values back, leaving the
   * whole house glowing.
   */
  private highlightedMeshes = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private framing = {
    isoPos: new THREE.Vector3(10.5, 22, 24.5),
    isoTarget: new THREE.Vector3(1.8, 0, -0.2),
    topHeight: 36
  };

  private onInteractiveClickCallback?: (data: InteractiveObjectData) => void;

  constructor(container: HTMLElement) {
    this.container = container;

    // 1. Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Static board: shadows only need an update when the scene changes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);
    this.labels = new LabelOverlay(container);
    this.labels.setOnClick(id => {
      if (!id.startsWith('stack:')) return;
      const zoneId = id.slice('stack:'.length);
      this.fanZoneId = this.fanZoneId === zoneId ? undefined : zoneId;
      this.lastBoardKey = '';
      if (this.lastRawState) this.syncState(this.lastRawState, this.lastPlacement, this.lastLayout);
    });
    this.labels.setOnGroupDrag((groupId, phase, clientX, clientY) => {
      this.handleGroupDrag(groupId, phase, clientX, clientY);
    });

    // 2. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a0e);
    this.scene.fog = new THREE.FogExp2(0x070a0e, 0.02);

    // 3. Camera & Controls
    this.camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 120);
    this.setCameraPreset('ISOMETRIC');

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // Do not go below table
    this.controls.minDistance = 3;
    this.controls.maxDistance = 80;
    this.controls.target.set(0, 0, 0);

    // 4. Lighting
    this.setupLighting();

    // 5. Table
    const table = GameTableBuilder.createTable();
    this.scene.add(table);
    this.scene.add(this.boardObjectsGroup);
    this.scene.add(this.dragTargetGroup);

    // 6. Raycaster & Animation Queue
    this.raycaster = new BoardRaycaster(this.camera, this.renderer.domElement);
    this.raycaster.onEntityPress(() => {
      // Lock the camera before OrbitControls processes the first drag pixels.
      this.controls.enabled = false;
    });
    this.raycaster.onClick((data) => {
      this.controls.enabled = true;
      if (this.onInteractiveClickCallback) {
        this.onInteractiveClickCallback(data);
      }
    });
    this.raycaster.onDragMove((entityId, clientX, clientY) => {
      this.followCardDrag(entityId, clientX, clientY);
    });

    this.animQueue = new TransactionalAnimationQueue(this.scene, this.camera);

    // 7. Event listeners & Render loop
    window.addEventListener('resize', this.onResize.bind(this));
    this.renderLoop();
  }

  private setupLighting(): void {
    // Warm ambient bounce
    const ambientLight = new THREE.AmbientLight(0xffe9c9, 0.82);
    this.scene.add(ambientLight);

    const hemisphere = new THREE.HemisphereLight(0x9db4d8, 0x1b1410, 0.38);
    this.scene.add(hemisphere);

    // Key lamp above the table (soft, warm)
    const keyLight = new THREE.DirectionalLight(0xfff2dd, 1.28);
    keyLight.position.set(7, 16, 9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 40;
    keyLight.shadow.camera.left = -16;
    keyLight.shadow.camera.right = 16;
    keyLight.shadow.camera.top = 16;
    keyLight.shadow.camera.bottom = -16;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.radius = 3;
    this.scene.add(keyLight);

    // Cool rim light from the back for depth separation
    const fillLight = new THREE.DirectionalLight(0x8ab6ff, 0.34);
    fillLight.position.set(-10, 9, -12);
    this.scene.add(fillLight);

    // Hanging pendant lamp: tight warm pool over the play surface
    const pendant = new THREE.PointLight(0xffdfae, 46, 46, 2);
    pendant.position.set(0, 8.5, 0);
    this.scene.add(pendant);

    // Inspection lamp: follows the camera target so whichever room you are
    // looking at stays readable inside the dark diorama.
    this.focusLight = new THREE.PointLight(0xffe2b6, 0, 11, 2);
    this.focusLight.position.set(0, 4, 2);
    this.scene.add(this.focusLight);
  }

  /** Keep the warm inspection light over the room under the camera target. */
  private updateFocusLight(): void {
    if (!this.focusLight) return;
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    // Blend from a tight close-up lamp to a broad wash as the camera pulls back,
    // so both the room-level and the whole-board view stay readable.
    const t = THREE.MathUtils.clamp((distance - 6) / 26, 0, 1);
    const height = THREE.MathUtils.lerp(3.4, 12, t);
    this.focusLight.position.set(
      target.x + THREE.MathUtils.lerp(0.6, 2.2, t),
      target.y + height,
      target.z + THREE.MathUtils.lerp(1.9, 5, t)
    );
    // Physical falloff is 1/d², so scale intensity with the square of the lift
    // to hold a roughly constant floor illuminance.
    this.focusLight.intensity = 2.6 * height * height;
    this.focusLight.distance = THREE.MathUtils.lerp(14, 52, t);
  }

  public getAnimationQueue(): TransactionalAnimationQueue {
    return this.animQueue;
  }

  public onInteractiveClick(cb: (data: InteractiveObjectData) => void): void {
    this.onInteractiveClickCallback = cb;
  }

  /** Hover updates the card-title label without rebuilding the board. */
  public onInteractiveHover(cb: (data: InteractiveObjectData | null) => void): void {
    this.raycaster.onHover(data => {
      this.hoveredEntityId = data?.type === 'ENTITY' ? data.id : undefined;
      if (this.lastState) this.refreshLabels(this.lastState);
      cb(data);
    });
  }

  public onEntityDrop(
    cb: (entityId: string, target: InteractiveObjectData | null, clientX: number, clientY: number) => void
  ): void {
    this.raycaster.onDrop(cb);
  }

  public onEntityDragStart(cb: (entityId: string) => void): void {
    this.raycaster.onDragStart(entityId => {
      // An entity drag is a placement gesture, not a camera orbit gesture.
      this.controls.enabled = false;
      const mesh = this.entityMeshes.get(entityId);
      if (mesh) {
        const offset = this.cardVisualOffsets.get(entityId) ?? { dx: 0, dz: 0 };
        this.draggedEntityId = entityId;
        const surfaceY = this.surfaceYAt(mesh.position.x, mesh.position.z, entityId);
        this.draggedHeldY = surfaceY + 0.45;
        this.draggedEntityOrigin = {
          position: [mesh.position.x, mesh.position.y, mesh.position.z],
          offset: { ...offset }
        };
      }
      cb(entityId);
    });
  }

  public onEntityDragEnd(cb: () => void): void {
    this.raycaster.onDragEnd(() => {
      this.controls.enabled = true;
      cb();
      this.draggedEntityId = undefined;
      this.draggedEntityOrigin = undefined;
      this.draggedHeldY = undefined;
    });
  }

  /** Show non-authoritative target rings while dragging an entity. */
  public setDropTargets(nodeIds: string[]): void {
    this.clearDropTargets();
    const unique = new Set(nodeIds);
    for (const id of unique) {
      const mesh = this.nodeMeshes.get(id);
      if (!mesh) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.22, 48),
        new THREE.MeshBasicMaterial({
          color: 0xf6dc9c,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(mesh.position.x, mesh.position.y + 0.24, mesh.position.z);
      this.dragTargetGroup.add(ring);
    }
  }

  public clearDropTargets(): void {
    while (this.dragTargetGroup.children.length > 0) {
      const child = this.dragTargetGroup.children[0];
      this.dragTargetGroup.remove(child);
      this.disposeObject3D(child);
    }
  }

  /**
   * Presentation-only card repositioning. This never changes GameState; it is
   * an escape hatch for visually overlapping cards on the table.
   */
  public moveCardToScreen(entityId: string, clientX: number, clientY: number): boolean {
    const mesh = this.entityMeshes.get(entityId);
    if (!mesh) return false;
    const point = this.screenToTable(clientX, clientY);
    if (!point) return false;

    const origin = this.draggedEntityOrigin;
    const old = this.cardVisualOffsets.get(entityId) ?? { dx: 0, dz: 0 };
    const baseX = origin ? origin.position[0] - origin.offset.dx : mesh.position.x - old.dx;
    const baseZ = origin ? origin.position[2] - origin.offset.dz : mesh.position.z - old.dz;
    const dx = point[0] - baseX;
    const dz = point[2] - baseZ;
    this.cardVisualOffsets.set(entityId, { dx, dz });
    mesh.position.x = baseX + dx;
    mesh.position.z = baseZ + dz;
    this.settleCard(entityId);
    if (this.lastState) this.refreshLabels(this.lastState);
    return true;
  }

  private screenToTable(clientX: number, clientY: number): [number, number, number] | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    BoardGameScene._scratchNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    BoardGameScene._scratchRaycaster.setFromCamera(BoardGameScene._scratchNdc, this.camera);
    if (!BoardGameScene._scratchRaycaster.ray.intersectPlane(BoardGameScene._scratchPlane, BoardGameScene._scratchPoint)) {
      return null;
    }
    return [BoardGameScene._scratchPoint.x, 0.08, BoardGameScene._scratchPoint.z];
  }

  private followCardDrag(entityId: string, clientX: number, clientY: number): void {
    if (entityId !== this.draggedEntityId) return;
    const mesh = this.entityMeshes.get(entityId);
    const point = this.screenToTable(clientX, clientY);
    if (!mesh || !point) return;
    this.cardSettles.delete(entityId);
    mesh.position.x = point[0];
    mesh.position.z = point[2];
    const surfaceY = this.surfaceYAt(point[0], point[2], entityId);
    this.draggedHeldY = surfaceY + 0.45;
  }

  /** Highest mesh top under an x/z point, excluding specified entity/entities. */
  private surfaceYAt(x: number, z: number, excludeIds?: string | string[]): number {
    const ids = excludeIds
      ? (Array.isArray(excludeIds) ? excludeIds : [excludeIds])
      : [];
    const excludedObjects = new Set<THREE.Object3D>();
    for (const id of ids) {
      const obj = this.entityMeshes.get(id);
      if (obj) {
        excludedObjects.add(obj);
        obj.traverse(child => excludedObjects.add(child));
      }
    }

    BoardGameScene._scratchRayOrigin.set(x, 30, z);
    BoardGameScene._scratchRaycaster.set(BoardGameScene._scratchRayOrigin, BoardGameScene._scratchRayDir);
    BoardGameScene._scratchRaycaster.camera = this.camera;
    // Newly created room/card meshes have not rendered yet. Raycaster reads
    // matrixWorld directly, so refresh it before querying the surface or a
    // freshly discarded card lands on the table height and clips the room tile.
    this.scene.updateMatrixWorld(true);
    const hits = BoardGameScene._scratchRaycaster.intersectObjects(this.boardObjectsGroup.children, true);

    const hit = hits.find(entry => {
      if (!(entry.object as THREE.Mesh).isMesh) return false;
      if (excludedObjects.has(entry.object)) return false;
      return true;
    });

    return hit?.point.y ?? 0.02;
  }

  public resetCardDrag(entityId: string): void {
    const origin = this.draggedEntityOrigin;
    const mesh = this.entityMeshes.get(entityId);
    if (!origin || !mesh) return;
    this.draggedHeldY = undefined;
    mesh.position.x = origin.position[0];
    mesh.position.z = origin.position[2];
    this.cardVisualOffsets.set(entityId, { ...origin.offset });
    this.cardSettles.set(entityId, {
      startY: mesh.position.y,
      targetY: origin.position[1],
      startedAt: performance.now(),
      duration: 220
    });
    if (this.lastState) this.refreshLabels(this.lastState);
  }

  public settleCard(entityId: string): void {
    const mesh = this.entityMeshes.get(entityId);
    if (!mesh) return;
    const surfaceY = this.surfaceYAt(mesh.position.x, mesh.position.z, entityId);
    const targetY = Math.max(0.08, surfaceY + 0.015);
    if (Math.abs(mesh.position.y - targetY) < 0.005) {
      mesh.position.y = targetY;
      return;
    }
    // If the frame loop is not ticking (background tab, throttled headless
    // page) an animated settle would freeze halfway and leave the card sunk
    // into the tile. Land it immediately in that case.
    if (performance.now() - this.lastFrameTime > 120) {
      mesh.position.y = targetY;
      this.cardSettles.delete(entityId);
      return;
    }
    this.cardSettles.set(entityId, {
      startY: mesh.position.y,
      targetY,
      startedAt: performance.now(),
      duration: 220
    });
  }

  private scheduleCardSettles(): void {
    for (const [id, entity] of Object.entries(this.lastState?.entities ?? {})) {
      if (entity?.type === 'CARD') {
        const zone = entity.zoneId ? this.lastState?.zones[entity.zoneId] : undefined;
        if (zone?.type === 'HAND' || zone?.type === 'DISCARD' || zone?.type === 'DECK' || zone?.type === 'EQUIP') {
          continue;
        }
        this.settleCard(id);
      }
    }
  }

  private updateCardSettles(now: number): void {
    if (this.draggedEntityId && this.draggedHeldY !== undefined && !this.cardSettles.has(this.draggedEntityId)) {
      const mesh = this.entityMeshes.get(this.draggedEntityId);
      if (mesh) mesh.position.y += (this.draggedHeldY - mesh.position.y) * 0.22;
    }
    if (this.groupDrag && this.groupHeldY !== undefined) {
      for (const id of this.groupDrag.bases.keys()) {
        const mesh = this.entityMeshes.get(id);
        if (mesh) mesh.position.y += (this.groupHeldY - mesh.position.y) * 0.22;
      }
    }
    for (const [id, settle] of this.cardSettles) {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) {
        this.cardSettles.delete(id);
        continue;
      }
      const t = Math.min(1, Math.max(0, (now - settle.startedAt) / settle.duration));
      const eased = 1 - (1 - t) * (1 - t);
      mesh.position.y = settle.startY + (settle.targetY - settle.startY) * eased;
      if (t >= 1) {
        mesh.position.y = settle.targetY;
        this.cardSettles.delete(id);
      }
    }
  }

  private updateRoomSettles(now: number): void {
    for (const [id, settle] of this.roomSettles) {
      const mesh = this.nodeMeshes.get(id);
      if (!mesh) {
        this.roomSettles.delete(id);
        continue;
      }
      const t = Math.min(1, Math.max(0, (now - settle.startedAt) / settle.duration));
      const eased = 1 - Math.pow(1 - t, 3);
      mesh.position.y = settle.startY + (settle.targetY - settle.startY) * eased;
      if (t >= 1) {
        mesh.position.y = settle.targetY;
        this.roomSettles.delete(id);
      }
    }
  }

  /** Presentation-only merge compatibility; never changes GameState. */
  public canMergeCards(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return false;
    const state = this.lastState;
    const source = state?.entities[sourceId];
    const target = state?.entities[targetId];
    if (!source || !target || !source.zoneId || source.zoneId !== target.zoneId) return false;
    return cardGroupKey(source as never) === cardGroupKey(target as never);
  }

  /** Snap a dragged card onto another card's visual pile. */
  public mergeCardsVisually(sourceId: string, targetId: string): void {
    const source = this.entityMeshes.get(sourceId);
    const target = this.entityMeshes.get(targetId);
    if (!source || !target) return;
    const old = this.cardVisualOffsets.get(sourceId) ?? { dx: 0, dz: 0 };
    const baseX = source.position.x - old.dx;
    const baseZ = source.position.z - old.dz;
    const dx = target.position.x - baseX + 0.12;
    const dz = target.position.z - baseZ + 0.08;
    this.cardVisualOffsets.set(sourceId, { dx, dz });
    source.position.set(baseX + dx, target.position.y + 0.02, baseZ + dz);
    if (this.lastState) this.refreshLabels(this.lastState);
  }

  /** Visual-only group drag from the ×N badge; never mutates GameState. */
  private handleGroupDrag(
    groupId: string,
    phase: 'start' | 'move' | 'end',
    clientX: number,
    clientY: number
  ): void {
    if (phase === 'start') {
      const ids = this.groupMembers.get(groupId) ?? [];
      const bases = new Map<string, [number, number, number]>();
      const offsets = new Map<string, { dx: number; dz: number }>();
      for (const id of ids) {
        const mesh = this.entityMeshes.get(id);
        if (!mesh) continue;
        const old = this.cardVisualOffsets.get(id) ?? { dx: 0, dz: 0 };
        offsets.set(id, { ...old });
        bases.set(id, [mesh.position.x - old.dx, mesh.position.y, mesh.position.z - old.dz]);
      }
      const startWorld = this.screenToTable(clientX, clientY) ?? [0, 0, 0];
      const maxSurface = Math.max(
        ...[...bases.values()].map(([x, , z]) => this.surfaceYAt(x, z, ids))
      );
      this.groupHeldY = maxSurface + 0.45;
      this.groupDrag = { groupId, startWorld, bases, offsets };
      return;
    }
    if (!this.groupDrag || this.groupDrag.groupId !== groupId) return;
    if (phase === 'end') {
      const ids = [...this.groupDrag.bases.keys()];
      this.groupDrag = undefined;
      this.groupHeldY = undefined;
      for (const id of ids) this.settleCard(id);
      if (this.lastState) this.refreshLabels(this.lastState);
      return;
    }

    const current = this.screenToTable(clientX, clientY);
    if (!current) return;
    const dx = current[0] - this.groupDrag.startWorld[0];
    const dz = current[2] - this.groupDrag.startWorld[2];

    for (const [id, [bx, _by, bz]] of this.groupDrag.bases) {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      const start = this.groupDrag.offsets.get(id) ?? { dx: 0, dz: 0 };
      const next = { dx: start.dx + dx, dz: start.dz + dz };
      this.cardVisualOffsets.set(id, next);
      mesh.position.x = bx + next.dx;
      mesh.position.z = bz + next.dz;
    }
  }

  /** Feed kernel visual events into the transactional animation queue. */
  public enqueueAnimations(events: import('@rds/kernel/types').VisualTraceEvent[]): void {
    if (events.length > 0) this.animQueue.enqueue(events);
  }

  /** Frame one floor (or the whole board) without changing logical coordinates. */
  public focusFloor(floorId: string): void {
    this.setVisibleFloor(floorId);
    if (!this.lastState) return;
    if (floorId === 'ALL') {
      this.fitCameraToBoard(this.lastState, this.lastPlacement, this.lastLayout);
      return;
    }
    const anchors = this.floorAnchorsFor(this.lastState, this.lastPlacement);
    const anchor = anchors[floorId];
    if (!anchor) return;
    const center = new THREE.Vector3(anchor.x, 0, anchor.z);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const distance = Math.max(anchor.width, anchor.depth) * 1.35 + 6;
    const targetPos = center.clone().add(direction.multiplyScalar(distance));
    this.skipFitUntil = performance.now() + 600;
    this.startCameraTween(targetPos, center, 480);
  }

  /**
   * Apply floor isolation filter: when a single floor is active, hide objects
   * belonging to other floors. 'ALL' restores full visibility.
   */
  public setVisibleFloor(floorId: string): void {
    this.visibleFloor = floorId;
    this.applyFloorFilter();
    if (this.lastState) {
      this.refreshLabels(this.lastState);
    }
  }

  public getVisibleFloor(): string {
    return this.visibleFloor;
  }

  private applyFloorFilter(): void {
    if (this.lastState?.gameId !== 'betrayal') return;
    const isIsolated = this.visibleFloor !== 'ALL';
    this.boardObjectsGroup.traverse(obj => {
      const floor = obj.userData?.floor as string | undefined;
      if (floor) {
        obj.visible = !isIsolated || floor === this.visibleFloor;
      }
    });
  }

  /**
   * Cinematic close-up on one board node. Used by the room inspector and the
   * modelling review harness; never mutates game state.
   */
  public focusNode(nodeId: string, distance = 6.8): boolean {
    const mesh = this.nodeMeshes.get(nodeId);
    if (!mesh || this.isDestroyed) return false;
    const target = mesh.position.clone();
    target.y = Math.max(0.12, target.y + 0.16);
    const dir = new THREE.Vector3(0.56, 0.92, 0.8).normalize();
    const position = target.clone().addScaledVector(dir, distance);
    this.skipFitUntil = performance.now() + 1400;
    this.startCameraTween(position, target, 520);
    return true;
  }

  /** Recover the wide board framing after a close-up. */
  public clearFocus(): void {
    if (!this.lastState) return;
    this.skipFitUntil = 0;
    this.hasFitted = false;
    this.fitCameraToBoard(this.lastState, this.lastPlacement, this.lastLayout);
  }

  /**
   * Reset board caching and camera tracking state when switching games,
   * guaranteeing that the incoming fixture is fully rendered and reframed.
   */
  public resetForNewGame(): void {
    this.lastBoardKey = '';
    this.lastFitSignature = '';
    this.hasFitted = false;
    this.lastActorRoomId = undefined;
    this.lastActorId = undefined;
    this.visibleFloor = 'ALL';
    this.prePlacementCamera = undefined;
    this.cancelCameraTween();
  }

  /**
   * Floating `力量 -2` over a character's miniature.
   *
   * Anchored to the meeple so the number sits on the figure itself rather than
   * a fixed screen spot; falls back to their current room when no token exists.
   */
  public popTraitBurst(playerId: string, text: string, tone: 'physical' | 'mental' | 'heal'): void {
    const mesh = this.entityMeshes.get(`meeple_${playerId}`);
    if (mesh) {
      this.labels.popBurst([mesh.position.x, mesh.position.y + 0.62, mesh.position.z], text, tone);
      return;
    }
    const player = this.lastState?.players[playerId];
    const room = player
      ? this.lastState?.mapGraph.nodes[String(player.customProps?.currentRoomId ?? '')]
      : undefined;
    if (room) {
      this.labels.popBurst([room.position[0], room.position[1] + 0.55, room.position[2]], text, tone);
    }
  }

  public setCameraPreset(preset: CameraPreset): void {
    const framing = this.framing;
    const scale = this.framingScale();

    switch (preset) {
      case 'ISOMETRIC': {
        const target = framing.isoTarget;
        const base = framing.isoPos;
        this.camera.position.set(
          target.x + (base.x - target.x) * scale,
          target.y + (base.y - target.y) * scale,
          target.z + (base.z - target.z) * scale
        );
        if (this.controls) this.controls.target.copy(target);
        break;
      }
      case 'TOP_DOWN':
        this.camera.position.set(framing.isoTarget.x, framing.topHeight * scale, 0.02);
        if (this.controls) this.controls.target.set(framing.isoTarget.x, 0, framing.isoTarget.z + 1.4);
        break;
      case 'PLAYER_1':
        this.camera.position.set(0, 7.5, 13);
        if (this.controls) this.controls.target.set(0, 0, 1.2);
        break;
      case 'PLAYER_2':
        this.camera.position.set(0, 7.5, -13);
        if (this.controls) this.controls.target.set(0, 0, -1.2);
        break;
    }
    this.controls?.update();
  }

  /** Pull the camera back on narrower windows so the board still fits. */
  private framingScale(): number {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
    return Math.min(1.25, Math.max(1, 1300 / Math.max(w, 900)));
  }

  /**
   * Map high-dimensional logical coordinates to renderer-world positions once
   * per sync; every renderer subsystem then works in ordinary XYZ.
   * If a room placement is currently previewed, a virtual node is injected so that
   * auto-layer offsets, floor mats, and neighbouring rooms dynamically
   * reflow to accommodate the prospective room before it is placed.
   */
  private projectForDisplay(
    state: ProjectedGameState,
    placement?: PlacementPreview
  ): { state: ProjectedGameState; placementPosition?: [number, number, number] } {
    const nodesToProject: Record<string, MapGraphNode> = { ...state.mapGraph.nodes };
    const previewId = '__placement_preview__';
    const isPlacing = !!(
      placement &&
      placement.floor &&
      placement.col !== undefined &&
      placement.row !== undefined
    );

    if (isPlacing) {
      const layerIndex =
        state.mapGraph.topology?.layers?.find(entry => entry.id === placement!.floor)?.index ?? 1;
      nodesToProject[previewId] = {
        id: previewId,
        type: 'ROOM',
        position: [placement!.col!, placement!.row!, layerIndex],
        positionSpace: 'grid',
        neighbors: [],
        layer: placement!.floor,
        props: {
          name: placement!.name,
          floor: placement!.floor,
          col: placement!.col,
          row: placement!.row,
          doors: placement!.doors,
          symbol: placement!.symbol
        }
      };
    }

    const projected = this.projection.projectAll(nodesToProject, {
      gameId: state.gameId,
      topology: state.mapGraph.topology,
      frames: state.mapGraph.frames
    });

    const nodes: ProjectedGameState['mapGraph']['nodes'] = {};
    for (const [id, node] of Object.entries(state.mapGraph.nodes)) {
      nodes[id] = {
        ...node,
        position: projected[id]?.position ?? node.position
      };
    }

    const placementPosition =
      isPlacing && previewId in projected
        ? (projected[previewId].position as [number, number, number])
        : undefined;

    return {
      state: {
        ...state,
        mapGraph: {
          ...state.mapGraph,
          nodes
        }
      },
      placementPosition
    };
  }

  /** Install a game/presentation-specific projection registry. */
  public setProjectionRegistry(registry: ProjectionRegistry): void {
    this.projection = registry;
    this.lastBoardKey = '';
    if (this.lastRawState) {
      this.syncState(this.lastRawState, this.lastPlacement, this.lastLayout);
    }
  }

  /**
   * Synchronize 3D Scene with Projected State
   */
  public syncState(
    rawState: ProjectedGameState,
    placement?: PlacementPreview,
    layout?: LayoutHints
  ): void {
    const syncStarted = performance.now();
    this.lastRawState = rawState;
    const { state, placementPosition } = this.projectForDisplay(rawState, placement);
    const displayPlacement: PlacementPreview | undefined = placement
      ? {
          ...placement,
          position: placementPosition ?? placement.position
        }
      : undefined;
    const wasPlacing = !!this.lastPlacement;
    const isPlacing = !!displayPlacement;
    this.lastState = state;
    this.lastPlacement = displayPlacement;
    this.lastLayout = layout;

    if (!wasPlacing && isPlacing) {
      this.beginPlacementCamera(displayPlacement!);
    } else if (wasPlacing && !isPlacing) {
      // The actor may have moved into the newly placed room during this sync;
      // `state` here is the post-placement projection, so it is what we centre on.
      this.endPlacementCamera(state);
    } else if (!isPlacing) {
      this.followActorIfMoved(state);
    }

    const placingSignature = displayPlacement
      ? `${displayPlacement.defId ?? displayPlacement.name}:${displayPlacement.floor}:${displayPlacement.col}:${displayPlacement.row}`
      : 'none';
    const boardKey = `${state.gameId}:${state.viewerId}:${state.actionLog.length}:${state.clock}:${placingSignature}`;
    const boardChanged = boardKey !== this.lastBoardKey;
    if (!boardChanged) {
      // Placement rotation only changes the preview mesh and connection links, not the board.
      this.clearPreviewObjects();
      if (displayPlacement) this.renderPlacementPreview(displayPlacement, state);
      this.applyFloorFilter();
      const fitSignature = `${Object.keys(state.mapGraph.nodes).length}:${displayPlacement ? 'placing' : ''}`;
      if (fitSignature !== this.lastFitSignature) {
        this.lastFitSignature = fitSignature;
        if (!this.cameraTween && performance.now() >= this.skipFitUntil) {
          this.fitCameraToBoard(state, displayPlacement, layout);
        }
      }
      this.lastSyncMs = performance.now() - syncStarted;
      return;
    }

    this.lastBoardKey = boardKey;
    this.raycaster.clearInteractive();

    // Clear previous board objects (dispose GPU resources; keep cached textures).
    this.clearBoardObjects();
    this.previewObjects = [];
    this.entityMeshes.clear();
    this.nodeMeshes.clear();
    this.edgeMeshes.clear();
    this.renderer.shadowMap.needsUpdate = true;

    // 1. Render Map Graph (Catan Hexes / Betrayal Rooms / Sanguosha Seats)
    this.renderMapGraph(state);

    // Track newly placed rooms to trigger placement animation
    const currentRoomIds = new Set<string>();
    Object.values(state.mapGraph.nodes).forEach(node => {
      if (node.type === 'ROOM') currentRoomIds.add(node.id);
    });
    if (this.knownRoomIds.size > 0) {
      const loopStale = performance.now() - this.lastFrameTime > 120;
      for (const id of currentRoomIds) {
        if (!this.knownRoomIds.has(id)) {
          const mesh = this.nodeMeshes.get(id);
          if (mesh) {
            if (loopStale) {
              // Frame loop throttled: land the tile immediately.
              this.roomSettles.delete(id);
            } else {
              this.roomSettles.set(id, {
                startY: mesh.position.y + 1.25,
                targetY: mesh.position.y,
                startedAt: performance.now(),
                duration: 380
              });
            }
            BoardGameAudio.playTilePlacement();
          }
        }
      }
    }
    this.knownRoomIds = currentRoomIds;

    // 2. Render Entities (Cards, Tokens, Buildings, Dice)
    this.renderEntities(state);
    this.scheduleCardSettles();
    if (displayPlacement) this.renderPlacementPreview(displayPlacement);

    // 3. Re-apply candidate highlights (build spots / buyable cards)
    this.applyHighlights();

    const fitSignature = `${Object.keys(state.mapGraph.nodes).length}:${displayPlacement ? 'placing' : ''}`;
    if (fitSignature !== this.lastFitSignature) {
      this.lastFitSignature = fitSignature;
      if (!this.cameraTween && performance.now() >= this.skipFitUntil) {
        this.fitCameraToBoard(state, displayPlacement, layout);
      }
    }
    this.refreshLabels(state);
    this.applyFloorFilter();
    this.lastSyncMs = performance.now() - syncStarted;
  }

  /** Build the label set from projected board state; rendering is screen-space. */
  private clusterMeshes(
    members: { id: string; mesh: THREE.Object3D }[],
    threshold: number
  ): { id: string; mesh: THREE.Object3D }[][] {
    const remaining = new Set(members.map((_, index) => index));
    const clusters: { id: string; mesh: THREE.Object3D }[][] = [];
    while (remaining.size > 0) {
      const seed = remaining.values().next().value as number;
      remaining.delete(seed);
      const cluster = [members[seed]];
      const queue = [seed];
      while (queue.length > 0) {
        const current = members[queue.shift()!];
        for (const index of [...remaining]) {
          const candidate = members[index];
          const dx = current.mesh.position.x - candidate.mesh.position.x;
          const dz = current.mesh.position.z - candidate.mesh.position.z;
          if (dx * dx + dz * dz <= threshold * threshold) {
            remaining.delete(index);
            cluster.push(candidate);
            queue.push(index);
          }
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  private refreshLabels(state: ProjectedGameState): void {
    const labels: WorldLabel[] = [];
    this.groupMembers.clear();
    const activeActor = state.activeActorId ?? state.activePlayerId;
    const isIsolated = state.gameId === 'betrayal' && this.visibleFloor !== 'ALL';

    for (const node of Object.values(state.mapGraph.nodes)) {
      if (node.type !== 'ROOM') continue;
      const floor = String(node.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      labels.push({
        id: `room:${node.id}`,
        text: String(node.props?.name ?? '房间'),
        world: [node.position[0], node.position[1] + 0.25, node.position[2] + 1.0],
        priority: 20,
        kind: 'room'
      });
    }

    for (const player of Object.values(state.players)) {
      if (!player.alive) continue;
      const roomId = String(player.customProps?.currentRoomId ?? '');
      const room = state.mapGraph.nodes[roomId];
      const seat = Object.values(state.mapGraph.nodes).find(
        node => node.type === 'SEAT' && node.props?.playerId === player.id
      );
      const node = room ?? seat;
      if (!node) continue;
      const floor = String(room?.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      labels.push({
        id: `player:${player.id}`,
        text: player.id === activeActor ? `▶ ${player.name}` : player.name,
        world: [node.position[0], node.position[1] + 0.9, node.position[2]],
        priority: player.id === activeActor ? 100 : 60,
        kind: 'player'
      });
    }

    for (const entity of Object.values(state.entities)) {
      const custom = entity.components?.custom;
      if (!custom?.monster || custom.dead) continue;
      const entityId = entity.id;
      if (!entityId) continue;
      const roomNode = state.mapGraph.nodes[String(custom.roomId ?? '')];
      const floor = String(roomNode?.props?.floor ?? '');
      if (isIsolated && floor && floor !== this.visibleFloor) continue;
      const npc = Object.values(state.npcs ?? {}).find(candidate => candidate.entityId === entityId);
      const mesh = this.entityMeshes.get(entityId);
      const spatial = entity.components?.spatial;
      const x = mesh?.position.x ?? spatial?.x ?? 0;
      const y = mesh?.position.y ?? spatial?.y ?? 0;
      const z = mesh?.position.z ?? spatial?.z ?? 0;
      labels.push({
        id: `monster:${entityId}`,
        text: String(custom.name ?? '怪物'),
        world: [x, y + 0.65, z],
        priority: npc?.id === activeActor ? 100 : 75,
        kind: 'monster'
      });
    }

    for (const [_zoneId, zone] of Object.entries(state.zones)) {
      const groups = buildCardGroups(zone, state.entities as Record<string, any>);
      for (const group of groups) {
        if (group.count < 2) continue;
        const members = group.entityIds
          .map(id => ({ id, mesh: this.entityMeshes.get(id) }))
          .filter((entry): entry is { id: string; mesh: THREE.Object3D } => !!entry.mesh);
        if (members.length < 2) continue;
        for (const cluster of this.clusterMeshes(members, 2.4)) {
          if (cluster.length < 2) continue;
          const center = cluster.reduce<[number, number, number]>(
            (sum, member) => [
              sum[0] + member.mesh.position.x,
              sum[1] + member.mesh.position.y,
              sum[2] + member.mesh.position.z
            ],
            [0, 0, 0]
          );
          const first = state.entities[group.topId];
          const title =
            first?.components?.cardFace?.title ??
            String(first?.components?.custom?.zh ?? first?.components?.custom?.defId ?? group.defId);
          const id = `${group.id}:${cluster[0].id}`;
          labels.push({
            id,
            text: title,
            count: cluster.length,
            world: [
              center[0] / cluster.length,
              center[1] / cluster.length + 0.55,
              center[2] / cluster.length
            ],
            priority: 60,
            kind: 'group',
            interactive: true,
            groupId: id
          });
          this.groupMembers.set(id, cluster.map(member => member.id));
        }
      }
    }

    for (const id of this.highlightIds) {
      const entity = state.entities[id];
      const mesh = this.entityMeshes.get(id);
      if (!entity || !mesh) continue;
      const text =
        entity.components?.cardFace?.title ??
        String(entity.components?.custom?.zh ?? entity.components?.custom?.name ?? entity.id);
      labels.push({
        id: `card:${id}`,
        text,
        world: [mesh.position.x, mesh.position.y + 0.4, mesh.position.z],
        priority: 95,
        kind: 'card'
      });
    }

    if (this.hoveredEntityId && !this.highlightIds.has(this.hoveredEntityId)) {
      const entity = state.entities[this.hoveredEntityId];
      const mesh = this.entityMeshes.get(this.hoveredEntityId);
      if (entity && mesh) {
        labels.push({
          id: `card:${this.hoveredEntityId}`,
          text:
            entity.components?.cardFace?.title ??
            String(entity.components?.custom?.zh ?? entity.components?.custom?.name ?? entity.id),
          world: [mesh.position.x, mesh.position.y + 0.4, mesh.position.z],
          priority: 96,
          kind: 'card'
        });
      }
    }

    this.labels.setLabels(labels);
  }

  private labelObstacles(): ScreenRect[] {
    const base = this.container.getBoundingClientRect();
    const obstacles: ScreenRect[] = [];
    for (const selector of ['.topbar', '.player-rail', '.action-dock', '.math-inspector-panel']) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        obstacles.push({
          x: rect.left - base.left,
          y: rect.top - base.top,
          width: rect.width,
          height: rect.height
        });
      }
    }
    return obstacles;
  }

  /** Lightweight profiling seam for deciding whether scene diffing is needed. */
  public getRenderStats(): RenderStats {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      lastSyncMs: Math.round(this.lastSyncMs * 100) / 100
    };
  }

  private clearPreviewObjects(): void {
    for (const object of this.previewObjects) {
      this.boardObjectsGroup.remove(object);
      this.disposeObject3D(object);
    }
    this.previewObjects = [];
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Remove and release GPU-side resources; shared texture caches stay alive. */
  private clearBoardObjects(): void {
    this.physics.clear();
    this.highlightedMeshes.clear();
    this.navArrowMeshes = [];
    while (this.boardObjectsGroup.children.length > 0) {
      const child = this.boardObjectsGroup.children[0];
      this.boardObjectsGroup.remove(child);
      this.disposeObject3D(child);
    }
  }

  private disposeObject3D(root: THREE.Object3D): void {
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      // Room tiles are cloned from a cached template and share geometry.
      if (mesh.geometry && !child.userData?.sharedGeometry) mesh.geometry.dispose();
      const material = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      for (const entry of materials) {
        // Pooled palette materials are reused across every room rebuild.
        if (entry.userData?.shared) continue;
        if (child.userData?.ownedTexture && 'map' in entry) {
          (entry as THREE.MeshBasicMaterial).map?.dispose();
        }
        entry.dispose();
      }
    });
  }

  /**
   * Highlight a set of interactive candidates (board targets, cards).
   * Incrementally updates visual highlights and label overlay without destroying/rebuilding the board.
   */
  public setHighlight(ids: string[] | null, _resync = true): void {
    const next = new Set(ids ?? []);
    if (this.highlightIds.size === next.size && [...this.highlightIds].every(id => next.has(id))) {
      return;
    }
    this.highlightIds = next;
    this.applyHighlights();
    if (this.lastState) {
      this.refreshLabels(this.lastState);
    }
  }

  public getHighlight(): string[] {
    return [...this.highlightIds];
  }

  private applyHighlights(): void {
    // 1. Put the original material back on every previously highlighted mesh.
    //    Swapping the reference (instead of copying values into the material)
    //    means a shared material can never be left tinted.
    for (const [mesh, original] of this.highlightedMeshes) {
      const tinted = mesh.material;
      mesh.material = original;
      const originalList = Array.isArray(original) ? original : [original];
      for (const mat of Array.isArray(tinted) ? tinted : [tinted]) {
        if (!originalList.includes(mat)) mat.dispose();
      }
    }
    this.highlightedMeshes.clear();

    if (this.highlightIds.size === 0) return;

    // 2. Give each highlighted mesh its own cloned, tinted material.
    const pulse = (obj: THREE.Object3D) => {
      obj.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || this.highlightedMeshes.has(mesh)) return;

        const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const clones = source.map(mat => {
          const clone = mat.clone() as THREE.MeshStandardMaterial;
          if ('emissive' in clone && clone.emissive) {
            clone.emissive = new THREE.Color(0xd9b45b);
            clone.emissiveIntensity = 0.85;
          } else if ('color' in clone && (clone as unknown as THREE.MeshBasicMaterial).color) {
            // SAFETY: MeshBasicMaterial and MeshStandardMaterial both implement color and opacity in Three.js runtime
            const basic = clone as unknown as THREE.MeshBasicMaterial;
            basic.color = new THREE.Color(0xf6dc9c);
            basic.opacity = 0.85;
          }
          return clone;
        });

        this.highlightedMeshes.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
      });
    };

    this.highlightIds.forEach(id => {
      const obj = this.nodeMeshes.get(id) || this.edgeMeshes.get(id) || this.entityMeshes.get(id);
      if (obj) pulse(obj);
    });
  }

  /**
   * Badges for moves the door grid cannot express.
   *
   * Stairs join rooms that share a grid cell across floors, the balcony drops
   * one floor, the rappel edge climbs back up, and the observatory lift reaches
   * any explored room. Without these the only way to use them was the action
   * dock, which is exactly the menu digging this pass removes.
   *
   * The drop is free, so it stays offered even with no moves left; stairs, the
   * rappel and the lift all spend a move and disappear at zero.
   */
  private addSpecialTraversalHints(
    state: ProjectedGameState,
    node: ProjectedGameState['mapGraph']['nodes'][string],
    nodeId: string,
    movesLeft = 0
  ): void {
    const canSpendMove = movesLeft > 0;
    const edges = Object.values(state.mapGraph.edges ?? {});
    const badges: {
      icon: string;
      label: string;
      color: string;
      metadata: Record<string, unknown>;
    }[] = [];

    const seenTargets = new Set<string>();

    for (const edge of edges) {
      const from = String((edge as { from?: string }).from ?? '');
      const to = String((edge as { to?: string }).to ?? '');
      const type = String((edge as { type?: string }).type ?? '');
      const isDirected = !!(edge as { directed?: boolean }).directed;

      let targetRoomId = '';
      if (from === nodeId) {
        targetRoomId = to;
      } else if (to === nodeId && !isDirected) {
        targetRoomId = from;
      }
      if (!targetRoomId || seenTargets.has(targetRoomId)) continue;

      const other = state.mapGraph.nodes[targetRoomId];
      if (!other) continue;

      if (type === 'STAIRS' && canSpendMove) {
        seenTargets.add(targetRoomId);
        const FLOOR_LEVEL: Record<string, number> = {
          BASEMENT: 0,
          GROUND: 1,
          UPPER: 2
        };
        const currentFloor = String(node.props?.floor ?? 'GROUND');
        const targetFloor = String(other.props?.floor ?? 'GROUND');
        const up = (FLOOR_LEVEL[targetFloor] ?? 1) > (FLOOR_LEVEL[currentFloor] ?? 1);
        badges.push({
          icon: up ? '⬆' : '⬇',
          label: up ? '上楼' : '下楼',
          color: up ? '#86a8c4' : '#d9b45b',
          metadata: {
            type: 'ROOM_NAV',
            fromRoomId: nodeId,
            targetRoomId,
            targetName: String(other.props?.name ?? '楼梯'),
            intent: 'interact'
          }
        });
      } else if (type === 'DROP' && canSpendMove && from === nodeId) {
        seenTargets.add(targetRoomId);
        badges.push({
          icon: '⬇',
          label: '跳下',
          color: '#e0a25c',
          metadata: {
            type: 'SPECIAL_MOVE',
            action: 'JUMP_DOWN',
            fromRoomId: nodeId,
            targetRoomId: to,
            targetName: String(other.props?.name ?? '舞厅'),
            intent: 'interact'
          }
        });
      }
    }

    // Rappel back up a drop edge when carrying rope.
    if (canSpendMove && !badges.some(badge => badge.metadata.action === 'JUMP_DOWN')) {
      for (const edge of edges) {
        const to = String((edge as { to?: string }).to ?? '');
        const type = String((edge as { type?: string }).type ?? '');
        if (to !== nodeId || type !== 'DROP') continue;
        const from = String((edge as { from?: string }).from ?? '');
        const upper = state.mapGraph.nodes[from];
        if (!upper) continue;
        badges.push({
          icon: '🪢',
          label: '攀绳',
          color: '#57c08b',
          metadata: {
            type: 'SPECIAL_MOVE',
            action: 'CLIMB_UP',
            fromRoomId: nodeId,
            targetRoomId: from,
            targetName: String(upper.props?.name ?? '上层'),
            intent: 'interact'
          }
        });
      }
    }

    if (canSpendMove && String(node.props?.special ?? '') === 'ELEVATOR') {
      badges.push({
        icon: '🛗',
        label: '乘电梯',
        color: '#b07bf0',
        metadata: { type: 'SPECIAL_MOVE', action: 'USE_ELEVATOR', fromRoomId: nodeId, intent: 'interact' }
      });
    }

    // Actionable room feature: the vault stays closed until someone cracks it.
    if (String(node.props?.special ?? '') === 'VAULT' && !node.props?.opened) {
      badges.push({
        icon: '🗄',
        label: '撬开金库',
        color: '#d9b45b',
        metadata: { type: 'ROOM_FEATURE', feature: 'VAULT', fromRoomId: nodeId, intent: 'interact' }
      });
    }

    // Passive hazard marker: indicates when debuffs take effect
    // (on entry vs on ending turn). Not clickable — pure informative billboard.
    const HAZARD: Record<string, { icon: string; label: string; color: string }> = {
      COAL_CHUTE: { icon: '⚠', label: '煤槽 · 滑落地下室', color: '#c9a24a' },
      COLLAPSED: { icon: '⚠', label: '坍塌 · 入内速度检定', color: '#c9a24a' },
      FURNACE: { icon: '⚠', label: '熔炉 · 停留灼伤', color: '#c9a24a' }
    };
    const hazard = HAZARD[String(node.props?.special ?? '')];
    const nodeFloor = String(node.props?.floor ?? '');
    if (hazard) {
      const plate = this.createLabelSprite(`${hazard.icon} ${hazard.label}`, hazard.color, 24);
      plate.position.set(node.position[0], node.position[1] + 0.72, node.position[2] + 1.02);
      plate.scale.set(1.7, 0.32, 1);
      plate.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(plate);
    }

    badges.forEach((badge, index) => {
      const angle = -Math.PI / 2 + (index - (badges.length - 1) / 2) * 0.72;
      const bx = node.position[0] + Math.cos(angle) * 0.62;
      const bz = node.position[2] + Math.sin(angle) * 0.62 + 0.42;

      const plate = new THREE.Mesh(
        new THREE.CylinderGeometry(0.19, 0.19, 0.03, 20),
        new THREE.MeshStandardMaterial({
          color: badge.color,
          emissive: badge.color,
          emissiveIntensity: 0.65,
          roughness: 0.35
        })
      );
      plate.position.set(bx, node.position[1] + 0.14, bz);
      plate.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(plate);
      const plateMat = plate.material as THREE.MeshStandardMaterial;
      const pulseTarget = new THREE.Group();
      pulseTarget.position.copy(plate.position);
      plate.position.set(0, 0, 0);
      pulseTarget.add(plate);
      pulseTarget.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(pulseTarget);
      this.navArrowMeshes.push({
        group: pulseTarget,
        material: plateMat,
        baseIntensity: 0.65,
        baseY: node.position[1] + 0.14
      });

      const glyph = this.createLabelSprite(`${badge.icon} ${badge.label}`, badge.color, 26);
      glyph.position.set(bx, node.position[1] + 0.42, bz);
      glyph.scale.set(1.35, 0.3, 1);
      glyph.userData.floor = nodeFloor;
      this.boardObjectsGroup.add(glyph);

      const interactiveId = `${nodeId}:special:${badge.metadata.action ?? 'nav'}:${String(badge.metadata.targetRoomId ?? '')}`;
      this.raycaster.registerInteractive(plate, {
        type: 'NODE',
        id: interactiveId,
        metadata: badge.metadata
      });
      this.raycaster.registerInteractive(glyph, {
        type: 'NODE',
        id: interactiveId,
        metadata: badge.metadata
      });
    });
  }

  private createFloorNavArrow(
    dir: 'N' | 'S' | 'E' | 'W',
    kind: 'NAV' | 'EXPLORE' | 'CHECK' | 'LOCKED',
    targetName: string
  ): { group: THREE.Group; material: THREE.MeshStandardMaterial } {
    const group = new THREE.Group();
    const isNav = kind === 'NAV';
    const isDanger = kind === 'CHECK' || kind === 'LOCKED';
    // Green = a plain move, amber = an unexplored doorway, red = passing this way
    // costs something (a trait check) or is impossible (the locked front door).
    const mainColor = isDanger ? 0xe23b2a : isNav ? 0x22dd77 : 0xe5a93c;
    const emissiveColor = isDanger ? 0xa11f12 : isNav ? 0x11bb66 : 0x9e6c1a;

    const arrowMat = new THREE.MeshStandardMaterial({
      color: mainColor,
      emissive: emissiveColor,
      emissiveIntensity: 1.0,
      roughness: 0.25,
      metalness: 0.1
    });

    // 2-part chevron on the floor: angled bars forming a chevron pointing forward (+Z local)
    const barGeom = new THREE.BoxGeometry(0.08, 0.024, 0.32);
    const leftBar = new THREE.Mesh(barGeom, arrowMat);
    leftBar.position.set(-0.11, 0.012, -0.06);
    leftBar.rotation.y = Math.PI / 4;
    group.add(leftBar);

    const rightBar = new THREE.Mesh(barGeom, arrowMat);
    rightBar.position.set(0.11, 0.012, -0.06);
    rightBar.rotation.y = -Math.PI / 4;
    group.add(rightBar);

    // Tip marker
    const tipGeom = new THREE.BoxGeometry(0.07, 0.025, 0.07);
    const tip = new THREE.Mesh(tipGeom, arrowMat);
    tip.position.set(0, 0.012, 0.07);
    tip.rotation.y = Math.PI / 4;
    group.add(tip);

    // Floor glowing aura disc
    const auraGeom = new THREE.CircleGeometry(0.36, 16);
    const auraMat = new THREE.MeshBasicMaterial({
      color: mainColor,
      transparent: true,
      opacity: 0.28,
      depthWrite: false
    });
    const aura = new THREE.Mesh(auraGeom, auraMat);
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.004;
    group.add(aura);

    // Floating text label
    const labelText = isNav ? `→ ${targetName}` : '▲ 探索';
    const label = this.createLabelSprite(
      labelText,
      isNav ? '#55ffaa' : '#f5c058',
      24
    );
    label.position.set(0, 0.24, 0);
    label.scale.set(1.4, 0.26, 1);
    group.add(label);

    const yAngles: Record<string, number> = {
      S: 0,
      N: Math.PI,
      E: Math.PI / 2,
      W: -Math.PI / 2
    };
    group.rotation.y = yAngles[dir] ?? 0;

    return { group, material: arrowMat };
  }

  private updateNavArrows(now: number): void {
    if (this.navArrowMeshes.length === 0) return;
    const pulse = 0.85 + 0.35 * Math.sin(now * 0.006);
    for (const item of this.navArrowMeshes) {
      if (item.material) item.material.emissiveIntensity = item.baseIntensity * pulse;
      if (item.group) item.group.position.y = item.baseY + 0.012 * Math.sin(now * 0.005);
    }
  }

  private renderMapGraph(state: ProjectedGameState): void {
    const graph = state.mapGraph;

    // Render Nodes
    Object.values(graph.nodes).forEach(node => {
      if (node.type === 'HEX') {
        const hexMesh = HexTileBuilder.createHexTileMesh(
          2.15,
          node.props.resource || 'wood',
          node.props.diceNumber,
          node.props.hasRobber
        );
        hexMesh.position.set(node.position[0], node.position[1], node.position[2]);
        this.boardObjectsGroup.add(hexMesh);
        this.nodeMeshes.set(node.id, hexMesh);

        this.raycaster.registerInteractive(hexMesh, {
          type: 'NODE',
          id: node.id,
          metadata: node.props
        });
      } else if (node.type === 'VERTEX') {
        // Vertex spot for settlements
        // Render subtle clickable marker if unoccupied
        if (!node.occupantEntityId) {
          const vGeom = new THREE.CylinderGeometry(0.17, 0.17, 0.04, 12);
          const vMat = new THREE.MeshBasicMaterial({
            color: 0xd9b45b,
            transparent: true,
            opacity: 0.22
          });
          const vMesh = new THREE.Mesh(vGeom, vMat);
          vMesh.position.set(node.position[0], 0.205, node.position[2]);
          this.boardObjectsGroup.add(vMesh);
          this.nodeMeshes.set(node.id, vMesh);

          this.raycaster.registerInteractive(vMesh, {
            type: 'NODE',
            id: node.id,
            metadata: { type: 'VERTEX' }
          });
        }
      } else if (node.type === 'ROOM') {
        // Betrayal room tile: 2.5D diorama with a door-aware furniture layout.
        const roomId = node.id.startsWith('room_') ? node.id.slice(5) : node.id;
        const roomMesh = RoomTileBuilder.createRoomMesh(
          node.props.name || 'Room',
          2.84,
          node.props.color,
          node.props.doors,
          {
            roomId,
            floor: node.props.floor,
            special: node.props.special,
            tags: node.props.tags,
            symbol: node.props.symbol,
            frontDoor: node.props.frontDoor
          }
        );
        roomMesh.position.set(node.position[0], node.position[1], node.position[2]);
        // Tagged so the floor filter can hide/show whole rooms without a rebuild.
        const nodeFloor = String(node.props.floor ?? '');
        roomMesh.userData.floor = nodeFloor;
        this.boardObjectsGroup.add(roomMesh);
        this.nodeMeshes.set(node.id, roomMesh);

        // Active actor movement & door exploration navigation
        const focusActorId =
          state.viewerId !== 'GOD'
            ? state.viewerId
            : (state.activeActorId ?? state.activePlayerId);
        const activeActor = state.players[focusActorId] ?? state.npcs?.[focusActorId];
        const currentActorRoomId = String(
          activeActor?.customProps?.currentRoomId ?? activeActor?.customProps?.roomId ?? ''
        );
        const movesLeft = Number(activeActor?.customProps?.movesLeft ?? 0);
        const isCurrentActorRoom = node.id === currentActorRoomId;

        // Register interactive door exploration and navigation hotspots
        const doors = (node.props.doors ?? []) as ('N' | 'S' | 'E' | 'W')[];
        const halfSize = 2.84 / 2;
        const DIR_DELTAS: Record<string, [number, number]> = {
          N: [0, -1],
          S: [0, 1],
          E: [1, 0],
          W: [-1, 0]
        };
        const OPPOSITES: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };

        for (const dir of doors) {
          const delta = DIR_DELTAS[dir] ?? [0, 0];
          const nodeCol = Number(node.props?.col);
          const nodeRow = Number(node.props?.row);
          const nodeFloor = String(node.props?.floor ?? '');

          const neighborRoom = Object.values(state.mapGraph.nodes).find(other => {
            const p = other.props;
            return (
              other.type === 'ROOM' &&
              p?.floor === nodeFloor &&
              Number(p?.col) === nodeCol + delta[0] &&
              Number(p?.row) === nodeRow + delta[1]
            );
          });

          const neighborDoors = Array.isArray(neighborRoom?.props?.doors) ? neighborRoom.props.doors : [];
          const isConnected = !!(
            neighborRoom &&
            neighborDoors.includes(OPPOSITES[dir]) &&
            (node.neighbors.includes(neighborRoom.id) ||
              !!state.mapGraph.edges[`edge_${node.id}_${neighborRoom.id}`] ||
              !!state.mapGraph.edges[`edge_${neighborRoom.id}_${node.id}`])
          );

          const doorGeom = new THREE.BoxGeometry(
            dir === 'N' || dir === 'S' ? 0.96 : 0.24,
            0.45,
            dir === 'W' || dir === 'E' ? 0.96 : 0.24
          );
          const doorMat = new THREE.MeshBasicMaterial({ visible: false });
          const doorMesh = new THREE.Mesh(doorGeom, doorMat);
          const dx = dir === 'W' ? -halfSize : dir === 'E' ? halfSize : 0;
          const dz = dir === 'N' ? -halfSize : dir === 'S' ? halfSize : 0;
          doorMesh.position.set(node.position[0] + dx, node.position[1] + 0.22, node.position[2] + dz);
          doorMesh.userData.floor = nodeFloor;
          this.boardObjectsGroup.add(doorMesh);

          const CHECK_ON_ENTRY = new Set(['COLLAPSED', 'COAL_CHUTE', 'FURNACE']);
          if (isConnected && neighborRoom) {
            const targetName = String(neighborRoom.props?.name ?? '相邻房间');
            if (isCurrentActorRoom && movesLeft > 0) {
              // Red when stepping through costs a check or health.
              const navKind = CHECK_ON_ENTRY.has(String(neighborRoom.props?.special ?? ''))
                ? 'CHECK'
                : 'NAV';
              const { group: navArrow, material } = this.createFloorNavArrow(dir, navKind, targetName);
              const ax = dir === 'W' ? -1.02 : dir === 'E' ? 1.02 : 0;
              const az = dir === 'N' ? -1.02 : dir === 'S' ? 1.02 : 0;
              const arrowY = node.position[1] + 0.125;
              navArrow.position.set(node.position[0] + ax, arrowY, node.position[2] + az);
              navArrow.userData.floor = nodeFloor;
              this.boardObjectsGroup.add(navArrow);

              this.navArrowMeshes.push({
                group: navArrow,
                material,
                baseIntensity: 1.0,
                baseY: arrowY
              });

              this.raycaster.registerInteractive(navArrow, {
                type: 'NODE',
                id: `${node.id}:nav:${neighborRoom.id}`,
                metadata: {
                  type: 'ROOM_NAV',
                  fromRoomId: node.id,
                  targetRoomId: neighborRoom.id,
                  targetName,
                  direction: dir,
                  intent: 'interact'
                }
              });
            }

            this.raycaster.registerInteractive(doorMesh, {
              type: 'NODE',
              id: `${node.id}:door_nav:${neighborRoom.id}`,
              metadata: {
                type: 'ROOM_NAV',
                fromRoomId: node.id,
                targetRoomId: neighborRoom.id,
                targetName,
                direction: dir,
                intent: 'interact'
              }
            });
          } else if (!neighborRoom) {
            if (isCurrentActorRoom && movesLeft > 0) {
              const isLockedFrontDoor =
                node.props.special === 'FRONT_DOOR' &&
                node.props.frontDoor === dir &&
                state.globalVars.frontDoorLocked !== false;
              const { group: exploreArrow, material } = this.createFloorNavArrow(
                dir,
                isLockedFrontDoor ? 'LOCKED' : 'EXPLORE',
                isLockedFrontDoor ? '前门锁死' : '探索'
              );
              const ax = dir === 'W' ? -1.02 : dir === 'E' ? 1.02 : 0;
              const az = dir === 'N' ? -1.02 : dir === 'S' ? 1.02 : 0;
              const arrowY = node.position[1] + 0.125;
              exploreArrow.position.set(node.position[0] + ax, arrowY, node.position[2] + az);
              exploreArrow.userData.floor = nodeFloor;
              this.boardObjectsGroup.add(exploreArrow);

              this.navArrowMeshes.push({
                group: exploreArrow,
                material,
                baseIntensity: 0.9,
                baseY: arrowY
              });

              this.raycaster.registerInteractive(exploreArrow, {
                type: 'NODE',
                id: `${node.id}:explore:${dir}`,
                metadata: {
                  type: 'DOOR',
                  roomId: node.id,
                  direction: dir,
                  name: node.props.name ?? '当前房间',
                  intent: 'interact'
                }
              });
            }

            this.raycaster.registerInteractive(doorMesh, {
              type: 'NODE',
              id: `${node.id}:door:${dir}`,
              metadata: {
                type: 'DOOR',
                roomId: node.id,
                direction: dir,
                name: node.props.name ?? '当前房间',
                intent: 'interact'
              }
            });
          }
        }

        // Special traversal: stairs between floors, the observatory lift, the
        // collapsed floor and the balcony drop are all one-way or cross-floor
        // links the plain door arrows cannot express.
        if (isCurrentActorRoom) {
          this.addSpecialTraversalHints(state, node, node.id, movesLeft);
        }

        const symbol = node.props?.symbol as string | undefined;
        if (symbol) {
          const icon = symbol === 'EVENT' ? '✦' : symbol === 'ITEM' ? '◆' : '👁';
          const color = symbol === 'EVENT' ? '#e0a25c' : symbol === 'ITEM' ? '#78d6a4' : '#c79bf0';
          const badge = this.createLabelSprite(icon, color, 46);
          badge.position.set(node.position[0] + 0.95, 0.34, node.position[2] - 0.95);
          badge.scale.set(0.42, 0.42, 1);
          badge.userData.floor = nodeFloor;
          this.boardObjectsGroup.add(badge);
        }

        // Room names are rendered by the DOM label overlay for collision-free layout.

        this.raycaster.registerInteractive(roomMesh, {
          type: 'NODE',
          id: node.id,
          metadata: node.props
        });
      } else if (node.type === 'SEAT') {
        // Sanguosha seat: brass ring + tinted disc + floating nameplate
        const seatPlayer = state.players[node.props.playerId];
        const seatColor = seatPlayer ? new THREE.Color(seatPlayer.color) : new THREE.Color(0x455a64);

        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.45, 0.05, 8, 48),
          new THREE.MeshStandardMaterial({
            color: seatColor,
            emissive: seatColor,
            emissiveIntensity: 0.35,
            metalness: 0.7,
            roughness: 0.3
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(node.position[0], 0.06, node.position[2]);
        this.boardObjectsGroup.add(ring);

        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(1.42, 48),
          new THREE.MeshStandardMaterial({
            color: seatColor,
            transparent: true,
            opacity: 0.12,
            roughness: 0.8
          })
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(node.position[0], 0.05, node.position[2]);
        this.boardObjectsGroup.add(disc);

        this.nodeMeshes.set(node.id, ring);
      }
    });

    // Render Edges (Catan Road Slots)
    Object.values(graph.edges).forEach(edge => {
      if (edge.type === 'ROAD_SLOT' && !edge.occupantEntityId) {
        const fromNode = graph.nodes[edge.from];
        const toNode = graph.nodes[edge.to];
        if (fromNode && toNode) {
          const mx = (fromNode.position[0] + toNode.position[0]) / 2;
          const mz = (fromNode.position[2] + toNode.position[2]) / 2;

          const slotGeom = new THREE.BoxGeometry(0.18, 0.04, 1.2);
          const slotMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.2
          });
          const slotMesh = new THREE.Mesh(slotGeom, slotMat);
          slotMesh.position.set(mx, 0.195, mz);

          // Align rotation with edge angle
          const angle = Math.atan2(toNode.position[0] - fromNode.position[0], toNode.position[2] - fromNode.position[2]);
          slotMesh.rotation.y = angle;

          this.boardObjectsGroup.add(slotMesh);
          this.edgeMeshes.set(edge.id, slotMesh);

          this.raycaster.registerInteractive(slotMesh, {
            type: 'EDGE',
            id: edge.id,
            metadata: { type: 'ROAD_SLOT' }
          });
        }
      }
    });
  }

  private renderEntities(state: ProjectedGameState): void {
    // ---------- Card zones ----------
    Object.values(state.zones).forEach(zone => {
      const items = zone.orderedEntities
        .map(id => state.entities[id])
        .filter((e): e is Partial<Entity> & { isMasked?: boolean; id: string } => !!e && !!e.id && e.type === 'CARD');

      if (items.length === 0) return;

      if (zone.type === 'DECK' || zone.type === 'DISCARD') {
        this.renderCardPile(state, zone, items);
        return;
      }

      if (zone.type === 'HAND') {
        this.renderHand(state, zone, items);
        return;
      }

      if (zone.type === 'EQUIP' || zone.type === 'JUDGE') {
        this.renderSeatCards(state, zone, items);
        return;
      }

      items.forEach((entity, index) =>
        this.renderCardEntity(
          entity,
          zone,
          index,
          items.length,
          !zone.id.startsWith('zone_room_') || index === items.length - 1
        )
      );
    });

    // ---------- Board buildings (Catan) ----------
    Object.values(state.entities).forEach(entity => {
      if (!entity || !entity.id || !entity.components) return;

      if (entity.type === 'BUILDING' && entity.components.building) {
        const b = entity.components.building;
        const sp = entity.components.spatial || { x: 0, y: 0.1, z: 0 };

        if (b.type === 'SETTLEMENT') {
          const mesh = TokenMeshBuilder.createSettlementMesh(b.color);
          mesh.position.set(sp.x, 0.2, sp.z);
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
          this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id });
        } else if (b.type === 'CITY') {
          const mesh = TokenMeshBuilder.createCityMesh(b.color);
          mesh.position.set(sp.x, 0.2, sp.z);
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
          this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id });
        } else if (b.type === 'ROAD') {
          const mesh = TokenMeshBuilder.createRoadMesh(b.color);
          mesh.position.set(sp.x, 0.19, sp.z);

          if (sp.nodeId && state.mapGraph.edges[sp.nodeId]) {
            const edge = state.mapGraph.edges[sp.nodeId];
            const fn = state.mapGraph.nodes[edge.from];
            const tn = state.mapGraph.nodes[edge.to];
            if (fn && tn) {
              mesh.rotation.y = Math.atan2(tn.position[0] - fn.position[0], tn.position[2] - fn.position[2]);
            }
          }
          this.boardObjectsGroup.add(mesh);
          this.entityMeshes.set(entity.id, mesh);
        }
      } else if (entity.type === 'TILE' && entity.components.cardFace?.type === 'NOBLE') {
        const face = entity.components.cardFace;
        const mesh = CardMeshBuilder.createCardMesh(face, 1.3, 1.3, !!entity.isMasked);
        const nobleEntities = Object.values(state.entities).filter(e => e?.components?.cardFace?.type === 'NOBLE');
        const index = nobleEntities.indexOf(entity);
        mesh.position.set(-7.6, 0.1, (index - 1) * 1.55);
        mesh.rotation.y = 0;
        this.boardObjectsGroup.add(mesh);
        this.entityMeshes.set(entity.id, mesh);
      }
    });

    // ---------- Dice ----------
    if (state.globalVars.lastDiceRoll && Array.isArray(state.globalVars.lastDiceRoll)) {
      const rolls = state.globalVars.lastDiceRoll;
      rolls.forEach((val: number, i: number) => {
        const diceMesh = DiceMeshBuilder.createDiceMesh(0.55);
        diceMesh.position.set(4.6 + i * 0.85, 0.28, 3.6);
        DiceMeshBuilder.setFaceUp(diceMesh, val);
        this.boardObjectsGroup.add(diceMesh);
        this.raycaster.registerInteractive(diceMesh, { type: 'DICE', id: `dice_${i}`, metadata: { value: val } });
        this.physics.add(`dice_${i}`, diceMesh, {
          kind: 'box',
          halfExtents: [0.275, 0.275, 0.275]
        });
      });
    }

    // ---------- Splendor gem bank ----------
    if (state.globalVars.bank) {
      const bank = state.globalVars.bank;
      const gemList = ['diamond', 'sapphire', 'emerald', 'ruby', 'onyx', 'gold'] as const;
      gemList.forEach((gem, idx) => {
        const count = bank[gem] || 0;
        const xPos = 7.4;
        const zPos = (idx - 2.5) * 1.05;

        for (let h = 0; h < Math.min(count, 5); h++) {
          // Pokémon Splendor: render tokens as imported Poké Balls
          const pkmnColor = Object.keys(PKMN_COLOR_TO_GEM).find(c => PKMN_COLOR_TO_GEM[c] === gem);
          const chip = TokenMeshBuilder.createGemTokenMesh(
            gem,
            0.36,
            !!pkmnColor,
            pkmnColor
          );
          chip.position.set(xPos - h * 0.16, 0.05 + h * 0.07, zPos);
          this.boardObjectsGroup.add(chip);
          this.raycaster.registerInteractive(chip, {
            type: 'ENTITY',
            id: `chip_bank_${gem}`,
            metadata: { gem, count }
          });
        }
      });
    }

    // ---------- Betrayal explorers ----------
    if (state.gameId === 'betrayal') {
      const occupantsByRoom = new Map<string, number>();
      Object.values(state.players).forEach(p => {
        if (!p.alive || p.customProps.banished) return;
        const roomId = p.customProps.currentRoomId;
        const room = state.mapGraph.nodes[roomId];
        if (!room) return;

        const slot = occupantsByRoom.get(roomId) ?? 0;
        occupantsByRoom.set(roomId, slot + 1);

        const angle = (slot % 3) * ((Math.PI * 2) / 3) + Math.PI / 6;
        const meeple = TokenMeshBuilder.createCharacterMiniature(
          p.role === 'TRAITOR' ? '#c62828' : p.color,
          { variant: p.role === 'TRAITOR' ? 'TRAITOR' : 'EXPLORER' }
        );
        // Stand in the room's open hub so the figure never hides behind a bed.
        meeple.position.set(
          room.position[0] + Math.cos(angle) * 0.3,
          room.position[1] + 0.12,
          room.position[2] + Math.sin(angle) * 0.3
        );
        meeple.userData.floor = String(room.props?.floor ?? '');
        this.boardObjectsGroup.add(meeple);
        this.entityMeshes.set(`meeple_${p.id}`, meeple);
      });

      // Monsters are MEEPLE entities with a `monster` custom component.
      Object.values(state.entities).forEach(entity => {
        const custom = entity?.components?.custom;
        if (!entity?.id || entity.type !== 'MEEPLE' || !custom?.monster) return;
        const spatial = entity.components?.spatial ?? { x: 0, y: 0.12, z: 0 };
        const roomNode = state.mapGraph.nodes[String(custom.roomId ?? '')];
        const x = roomNode ? roomNode.position[0] - 0.28 : spatial.x;
        const z = roomNode ? roomNode.position[2] + 0.3 : spatial.z;
        const stunned = !!custom.stunned;
        const monster = TokenMeshBuilder.createCharacterMiniature(String(custom.color ?? '#b07bf0'), {
          variant: 'MONSTER',
          scale: 1.45
        });
        monster.position.set(x, 0.12, z);
        if (stunned) monster.rotation.z = Math.PI / 2;
        if (roomNode?.props?.floor) monster.userData.floor = String(roomNode.props.floor);
        this.boardObjectsGroup.add(monster);
        this.entityMeshes.set(entity.id, monster);
        this.raycaster.registerInteractive(monster, {
          type: 'ENTITY',
          id: entity.id,
          metadata: custom
        });

        // Monster nameplates are DOM labels; keep the spatial mesh only.
      });
    }

    // ---------- Generic token stacks ----------
    const tokens = Object.values(state.entities).filter(
      entity => entity?.id && entity.type === 'TOKEN'
    );
    for (const candidate of tokens) {
      const entity = candidate as Entity;
      const entityId = String(entity.id);
      const zone = state.zones[entity.zoneId];
      if (!zone) continue;
      const spatial = entity.components?.spatial;
      const anchor = spatial
        ? [spatial.x, spatial.y, spatial.z]
        : zone.anchorPosition ?? [0, 0.1, 0];
      const index = Math.max(0, zone.orderedEntities.indexOf(entityId));
      const color = String(entity.components?.custom?.color ?? '#d9b45b');
      const token = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.07, 24),
        new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 })
      );
      token.position.set(anchor[0], anchor[1] + index * 0.06, anchor[2]);
      this.boardObjectsGroup.add(token);
      this.entityMeshes.set(entityId, token);
      this.physics.add(entityId, token, { kind: 'cylinder', radius: 0.2, halfHeight: 0.035 });
      if (index === zone.orderedEntities.length - 1) {
        this.raycaster.registerInteractive(token, { type: 'ENTITY', id: entityId });
      }
    }

    // ---------- Game-specific table dressing ----------
    this.renderGameDecor(state);
  }

  /* ------------------------------------------------------------------ */
  /* Card piles (draw deck / discard)                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Presentation-only fit: logical coordinates never change. Layout hints
   * come from GameCapabilities, not from a gameId switch in the renderer.
   */
  private fitCameraToBoard(
    state: ProjectedGameState,
    placement?: PlacementPreview,
    layout?: LayoutHints
  ): void {
    if (!this.controls) return;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const node of Object.values(state.mapGraph.nodes)) {
      xs.push(node.position[0]);
      zs.push(node.position[2]);
    }
    if (placement) {
      xs.push(placement.position[0]);
      zs.push(placement.position[2]);
    }
    if (xs.length === 0) return;

    const padding = layout?.padding ?? 4;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const targetX = (minX + maxX) / 2;
    const targetZ = (minZ + maxZ) / 2;
    const spanX = maxX - minX + padding * 2;
    const spanZ = maxZ - minZ + padding * 2;
    const target = new THREE.Vector3(targetX, 0, targetZ);
    const direction = this.camera.position.clone().sub(this.controls.target);
    if ((!this.hasFitted || direction.lengthSq() < 0.001) && layout?.cameraDirection) {
      direction.set(...layout.cameraDirection);
    } else if (direction.lengthSq() < 0.001) {
      direction.set(0.6, 24, 31);
    }

    // Fit from the real field of view instead of a fixed multiplier, so the
    // board fills the viewport whatever its aspect ratio or footprint.
    const aspect = this.camera.aspect > 0.1 ? this.camera.aspect : 1.6;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * aspect);
    const halfX = spanX / 2;
    const halfZ = spanZ / 2;
    // The tilted camera foreshortens Z, so the vertical requirement is relaxed.
    const fitHorizontal = halfX / Math.tan(fovH / 2);
    const fitVertical = (halfZ * 0.72) / Math.tan(fovV / 2);
    const needed = Math.max(
      layout?.minDistance ?? 14,
      Math.max(fitHorizontal, fitVertical) * 1.1 + 3
    );
    // Never zoom in past what the user already chose.
    const distance = Math.min(180, Math.max(this.camera.position.distanceTo(this.controls.target), needed));

    this.controls.target.copy(target);
    this.camera.position.copy(target).add(direction.normalize().multiplyScalar(distance));
    this.controls.maxDistance = 190;
    this.controls.update();
    this.hasFitted = true;
  }

  private beginPlacementCamera(placement: PlacementPreview): void {
    if (this.cameraTween) return;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    this.prePlacementCamera = {
      position: startPosition.clone(),
      target: startTarget.clone()
    };

    // Frame the room being placed, not the whole board: the player is choosing
    // an orientation for that tile, so it should be the thing under the lens.
    const centre = new THREE.Vector3(
      placement.position[0],
      Math.max(0.12, placement.position[1] + 0.16),
      placement.position[2]
    );

    // Keep the player's chosen bearing, come in closer, and lift the eye above
    // the wide-board height so the new tile is read from above with its
    // neighbours still visible around it.
    const dir = startPosition.clone().sub(startTarget);
    const len = dir.length() || 1;
    const arm = Math.min(len, 15);
    dir.normalize();
    // Steepen the arm before scaling: looking down on the tile beats skimming
    // it from the side, which is what a straight copy of the bearing gives.
    dir.y = Math.max(dir.y, 0.72);
    dir.normalize().multiplyScalar(arm);
    const lifted = centre.clone().add(dir);
    lifted.y = Math.max(lifted.y, startPosition.y + Math.max(3.4, arm * 0.34));

    this.skipFitUntil = performance.now() + 900;
    this.startCameraTween(lifted, centre, 650);
  }

  private endPlacementCamera(state?: ProjectedGameState): void {
    const previous = this.prePlacementCamera;
    this.prePlacementCamera = undefined;
    this.cancelCameraTween();
    if (!previous) {
      this.controls.enabled = true;
      return;
    }

    // Rather than jumping back to the old pre-placement room and panning from there,
    // transition directly from the elevated placement view down to the actor
    // in the new room, smoothly restoring the normal playing distance and eye height.
    const focus = state ? this.actorFocusPoint(state) : undefined;
    const targetCenter = focus ?? previous.target;

    // Normal playing offset vector (restores pre-placement eye height & distance)
    const normalOffset = previous.position.clone().sub(previous.target);
    const targetCamPos = targetCenter.clone().add(normalOffset);

    this.skipFitUntil = performance.now() + 650;
    this.startCameraTween(targetCamPos, targetCenter, 460);
  }

  /**
   * Keep the active actor framed when they move or when turns switch.
   *
   * Movement and turn handovers used to leave the camera behind, especially
   * in GOD / spectator mode where actors occupy completely different rooms.
   * Panning (not orbiting or dollying) preserves the player's chosen bearing.
   */
  private followActorIfMoved(state: ProjectedGameState): void {
    const actorId = state.activeActorId ?? state.activePlayerId;
    const actor = actorId ? (state.players[actorId] ?? state.npcs?.[actorId]) : undefined;
    const roomId = String(actor?.customProps?.currentRoomId ?? actor?.customProps?.roomId ?? '');
    const previousRoomId = this.lastActorRoomId;
    const previousActorId = this.lastActorId;

    this.lastActorId = actorId;

    // First sync only records the starting actor & room; there is nothing to follow yet.
    if (!previousRoomId || !roomId) {
      this.lastActorRoomId = roomId || undefined;
      return;
    }

    const actorSwitched = !!previousActorId && previousActorId !== actorId;
    const roomChanged = previousRoomId !== roomId;

    if (!actorSwitched && !roomChanged) return;

    // When an actor switch occurs (turn handed over), it takes precedence over
    // lingering skipFit timers so the new active character is immediately framed.
    if (!actorSwitched && (this.cameraTween || performance.now() < this.skipFitUntil)) {
      // Keep previousRoomId untouched so the next frame can retry once skipFit passes
      return;
    }

    this.lastActorRoomId = roomId || undefined;

    const roomNode = state.mapGraph.nodes[roomId];
    const newFloor = String(roomNode?.props?.floor ?? '');
    if (this.visibleFloor !== 'ALL' && newFloor && newFloor !== this.visibleFloor) {
      this.focusFloor(newFloor);
      return;
    }

    const focus = this.actorFocusPoint(state);
    if (!focus) return;
    this.panToKeepBearing(focus, actorSwitched ? 520 : 460);
  }

  /**
   * World point to frame after a placement or turn change: the room the
   * active actor (player or monster) now stands in.
   */
  private actorFocusPoint(state: ProjectedGameState): THREE.Vector3 | undefined {
    const actorId = state.activeActorId ?? state.activePlayerId;
    const actor = actorId ? (state.players[actorId] ?? state.npcs?.[actorId]) : undefined;
    const roomId = String(actor?.customProps?.currentRoomId ?? actor?.customProps?.roomId ?? '');
    const node = roomId ? state.mapGraph.nodes[roomId] : undefined;
    if (!node) return undefined;
    return new THREE.Vector3(node.position[0], Math.max(0.12, node.position[1] + 0.16), node.position[2]);
  }

  /**
   * Slide the orbit target onto `point` without changing the camera's bearing
   * or its distance to the board, so only the framing shifts.
   */
  private panToKeepBearing(point: THREE.Vector3, duration: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.skipFitUntil = performance.now() + duration + 300;
    this.startCameraTween(point.clone().add(offset), point.clone(), duration);
  }

  /** Abort any in-flight camera tween and its safety timer. */
  private cancelCameraTween(): void {
    if (this.cameraTweenTimer !== undefined) {
      window.clearTimeout(this.cameraTweenTimer);
      this.cameraTweenTimer = undefined;
    }
    this.cameraTween = undefined;
  }

  private startCameraTween(
    toPosition: THREE.Vector3,
    toTarget: THREE.Vector3,
    duration: number
  ): void {
    this.cameraTween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: toPosition.clone(),
      toTarget: toTarget.clone(),
      startedAt: performance.now(),
      duration
    };
    this.controls.enabled = false;
    // rAF stalls in background tabs would otherwise freeze the camera mid-tween
    // with the orbit controls permanently disabled. Force the final pose.
    if (this.cameraTweenTimer !== undefined) window.clearTimeout(this.cameraTweenTimer);
    this.cameraTweenTimer = window.setTimeout(() => {
      this.cameraTweenTimer = undefined;
      this.finishCameraTween();
    }, duration + 60);
  }

  /** Snap the active camera tween to its destination and hand control back. */
  private finishCameraTween(): void {
    const tween = this.cameraTween;
    if (!tween) {
      this.controls.enabled = true;
      return;
    }
    this.camera.position.copy(tween.toPosition);
    this.controls.target.copy(tween.toTarget);
    this.cameraTween = undefined;
    this.controls.enabled = true;
    this.controls.update();
  }

  private updateCameraTween(now: number): void {
    const tween = this.cameraTween;
    if (!tween) return;
    const t = Math.min(1, Math.max(0, (now - tween.startedAt) / tween.duration));
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (t >= 1) {
      if (this.cameraTweenTimer !== undefined) {
        window.clearTimeout(this.cameraTweenTimer);
        this.cameraTweenTimer = undefined;
      }
      this.finishCameraTween();
    }
  }

  /**
   * Builds the 3D room placement preview: semi-transparent ghost tile, in-world
   * rotate & confirm widgets, and dynamic portal link arches / door beacons.
   */
  private renderPlacementPreview(placement: PlacementPreview, _state?: ProjectedGameState): void {
    if (this.lastPreviewRotation !== undefined && this.lastPreviewRotation !== placement.rotation) {
      BoardGameAudio.playCardFlip();
    }
    this.lastPreviewRotation = placement.rotation;

    const group = RoomTileBuilder.createRoomMesh(
      placement.name,
      2.84,
      placement.color,
      placement.doors as ('N' | 'S' | 'E' | 'W')[],
      {
        floor: placement.floor,
        isPreview: true
      }
    );
    group.position.set(placement.position[0], placement.position[1] + 0.12, placement.position[2]);
    group.rotation.y = -placement.rotation * (Math.PI / 2);
    // Clone the materials before mutating: the palette is shared by every room,
    // so editing it here would ghost the whole board.
    group.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = source.map(material => {
        if (!material) return material;
        const copy = material.clone();
        copy.transparent = true;
        copy.opacity = 0.8;
        copy.depthWrite = false;
        return copy;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
    });
    this.boardObjectsGroup.add(group);
    this.previewObjects.push(group);

    // Register ghost tile click to rotate directly in 3D
    this.raycaster.registerInteractive(group, {
      type: 'NODE',
      id: 'placement_rotate',
      metadata: { intent: 'rotate' }
    });

    // 3D In-World Interactive Rotate Gizmo (Brass Torus Ring)
    const rotateGizmoGeom = new THREE.TorusGeometry(0.48, 0.05, 8, 24);
    const rotateGizmoMat = new THREE.MeshBasicMaterial({ color: 0xd9b45b });
    const rotateGizmo = new THREE.Mesh(rotateGizmoGeom, rotateGizmoMat);
    rotateGizmo.rotation.x = Math.PI / 2;
    rotateGizmo.position.set(placement.position[0] - 0.75, placement.position[1] + 0.65, placement.position[2]);
    this.boardObjectsGroup.add(rotateGizmo);
    this.previewObjects.push(rotateGizmo);
    this.raycaster.registerInteractive(rotateGizmo, {
      type: 'NODE',
      id: 'placement_rotate',
      metadata: { intent: 'rotate' }
    });

    // 3D In-World Interactive Confirm Gizmo (Emerald Cylinder Disc)
    const confirmGizmoGeom = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16);
    const confirmGizmoMat = new THREE.MeshBasicMaterial({ color: 0x2e9b4e });
    const confirmGizmo = new THREE.Mesh(confirmGizmoGeom, confirmGizmoMat);
    confirmGizmo.position.set(placement.position[0] + 0.75, placement.position[1] + 0.65, placement.position[2]);
    this.boardObjectsGroup.add(confirmGizmo);
    this.previewObjects.push(confirmGizmo);
    this.raycaster.registerInteractive(confirmGizmo, {
      type: 'NODE',
      id: 'placement_confirm',
      metadata: { intent: 'confirm' }
    });

    // 3D Door Connection Visuals: luminous bridges, portal rings and exploration chevrons
    const half = 2.84 / 2;
    const DIR_DELTAS: Record<string, [number, number]> = {
      N: [0, -half],
      S: [0, half],
      E: [half, 0],
      W: [-half, 0]
    };

    for (const conn of placement.connections ?? []) {
      const dir = conn.dir;
      const delta = DIR_DELTAS[dir];
      if (!delta) continue;
      const dx = delta[0];
      const dz = delta[1];
      const doorX = placement.position[0] + dx;
      const doorY = placement.position[1];
      const doorZ = placement.position[2] + dz;

      if (conn.status === 'connected') {
        // Luminous emerald connection bridge between the two doors
        const bridgeGeom = new THREE.BoxGeometry(
          dir === 'N' || dir === 'S' ? 0.96 : 0.2,
          0.04,
          dir === 'N' || dir === 'S' ? 0.2 : 0.96
        );
        const bridgeMat = new THREE.MeshStandardMaterial({
          color: 0x22dd77,
          emissive: 0x11bb66,
          emissiveIntensity: 1.2,
          roughness: 0.3
        });
        const bridge = new THREE.Mesh(bridgeGeom, bridgeMat);
        bridge.position.set(doorX, doorY + 0.128, doorZ);
        this.boardObjectsGroup.add(bridge);
        this.previewObjects.push(bridge);

        // Glowing portal energy ring standing upright in the doorway
        const archGeom = new THREE.TorusGeometry(0.36, 0.024, 8, 24);
        const archMat = new THREE.MeshBasicMaterial({ color: 0x44ffaa });
        const arch = new THREE.Mesh(archGeom, archMat);
        arch.position.set(doorX, doorY + 0.38, doorZ);
        if (dir === 'E' || dir === 'W') arch.rotation.y = Math.PI / 2;
        this.boardObjectsGroup.add(arch);
        this.previewObjects.push(arch);

        // Floating tag
        const tag = this.createLabelSprite(
          `🔗 ${conn.dirZh} ↔ ${conn.neighborRoomName ?? '相邻房间'}`,
          '#55ffaa',
          24
        );
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.15 : 0), doorY + 0.72, doorZ + (dz ? Math.sign(dz) * 0.15 : 0));
        tag.scale.set(2.0, 0.34, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      } else if (conn.status === 'blocked') {
        // Warning red barrier
        const blockGeom = new THREE.BoxGeometry(
          dir === 'N' || dir === 'S' ? 0.76 : 0.08,
          0.16,
          dir === 'N' || dir === 'S' ? 0.08 : 0.76
        );
        const blockMat = new THREE.MeshStandardMaterial({
          color: 0x5a1818,
          emissive: 0x2a0808,
          roughness: 0.8
        });
        const block = new THREE.Mesh(blockGeom, blockMat);
        block.position.set(doorX, doorY + 0.24, doorZ);
        this.boardObjectsGroup.add(block);
        this.previewObjects.push(block);

        const tag = this.createLabelSprite(`✕ ${conn.dirZh}面墙`, '#ff7777', 22);
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.1 : 0), doorY + 0.58, doorZ + (dz ? Math.sign(dz) * 0.1 : 0));
        tag.scale.set(1.6, 0.28, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      } else if (conn.status === 'open') {
        // Open exploration tag
        const tag = this.createLabelSprite(`▲ ${conn.dirZh}未知`, '#d9b45b', 22);
        tag.position.set(doorX + (dx ? Math.sign(dx) * 0.1 : 0), doorY + 0.52, doorZ + (dz ? Math.sign(dz) * 0.1 : 0));
        tag.scale.set(1.4, 0.26, 1);
        this.boardObjectsGroup.add(tag);
        this.previewObjects.push(tag);
      }
    }

    const connectedList = (placement.connections ?? []).filter(c => c.connected);
    const connectedDetails = connectedList.length > 0
      ? ` · 🔗 打通 ${connectedList.length} 门 (${connectedList.map(c => `${c.dirZh}↔${c.neighborRoomName}`).join('，')})`
      : ' · ⚠️ 未与相邻房间门位接通';
    const label = this.createLabelSprite(
      `↻ 点击旋转 (${placement.rotation * 90}°)${connectedDetails} · ✓ 确认放置`,
      connectedList.length > 0 ? '#66ffbb' : '#e3c77b',
      30
    );
    label.position.set(placement.position[0], placement.position[1] + 1.25, placement.position[2]);
    label.scale.set(connectedList.length > 0 ? 3.4 : 3.0, 0.45, 1);
    this.boardObjectsGroup.add(label);
    this.previewObjects.push(label);

    if (placement.floor) {
      this.previewObjects.forEach(obj => {
        obj.userData.floor = placement.floor;
      });
    }
  }

  private renderCardPile(
    _state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const anchor = zone.anchorPosition ?? [0, 0.06, 0];
    const isDiscard = zone.type === 'DISCARD';
    const visible = Math.min(items.length, 4);

    for (let i = 0; i < visible; i++) {
      const isTop = i === visible - 1;
      const faceUp = isDiscard && isTop;
      const face = faceUp ? items[i].components?.cardFace || { title: 'Discard' } : { title: 'Card' };
      const mesh = CardMeshBuilder.createCardMesh(face, 1.25, 1.85, !faceUp);
      mesh.position.set(anchor[0], anchor[1] + i * 0.02, anchor[2]);
      mesh.rotation.y = i % 2 === 0 ? 0.02 : -0.03;
      this.boardObjectsGroup.add(mesh);
      if (isTop) this.entityMeshes.set(items[i].id, mesh);
    }

    const label = this.createLabelSprite(`${zone.name} · ${items.length}`, '#cbb57a');
    label.position.set(anchor[0], 0.55, anchor[2]);
    label.scale.set(2.6, 0.52, 1);
    this.boardObjectsGroup.add(label);
  }

  /* ------------------------------------------------------------------ */
  /* Hands around the table                                              */
  /* ------------------------------------------------------------------ */

  private seatFrame(state: ProjectedGameState, ownerId?: string) {
    const seatNode = Object.values(state.mapGraph.nodes).find(
      n => n.type === 'SEAT' && n.props.playerId === ownerId
    );

    if (seatNode) {
      const x = seatNode.position[0];
      const z = seatNode.position[2];
      const len = Math.max(0.0001, Math.hypot(x, z));
      return {
        x,
        z,
        outX: x / len,
        outZ: z / len,
        facing: Math.atan2(x / len, z / len)
      };
    }

    const ownerIndex = Math.max(0, state.playerOrder.indexOf(ownerId || 'p1'));
    const seatCount = Math.max(state.playerOrder.length, 2);
    const theta = Math.PI / 2 + (ownerIndex * Math.PI * 2) / seatCount;
    const x = Math.cos(theta) * 8.2;
    const z = Math.sin(theta) * 5.2;
    return {
      x,
      z,
      outX: Math.cos(theta),
      outZ: Math.sin(theta),
      facing: Math.atan2(Math.cos(theta), Math.sin(theta))
    };
  }

  private renderHand(
    state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const frame = this.seatFrame(state, zone.ownerId);
    const perpX = -frame.outZ;
    const perpZ = frame.outX;

    const limit = Math.min(items.length, 10);
    const cardScale = limit > 6 ? 0.5 : limit > 4 ? 0.56 : 0.62;
    const step = 1.12 * cardScale + 0.08;

    for (let i = 0; i < limit; i++) {
      const entity = items[i];
      const face = entity.components?.cardFace || { title: 'Card' };
      const mesh = CardMeshBuilder.createCardMesh(face, 1.12, 1.68, !!entity.isMasked);

      const spread = (i - (limit - 1) / 2) * step;
      const fanAngle = (i - (limit - 1) / 2) * 0.055;
      mesh.scale.set(cardScale, cardScale, cardScale);
      mesh.position.set(
        frame.x + frame.outX * 2.0 + perpX * spread,
        0.13 + Math.abs(fanAngle) * 0.18,
        frame.z + frame.outZ * 2.0 + perpZ * spread
      );
      mesh.rotation.y = frame.facing + fanAngle;
      this.applyCardVisualOffset(entity.id, mesh);
      this.boardObjectsGroup.add(mesh);
      this.entityMeshes.set(entity.id, mesh);
      this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id, metadata: face });
    }
  }

  /** Equipment / judgement cards sit beside their owner's seat. */
  private renderSeatCards(
    state: ProjectedGameState,
    zone: ProjectedGameState['zones'][string],
    items: (Partial<Entity> & { isMasked?: boolean; id: string })[]
  ): void {
    const frame = this.seatFrame(state, zone.ownerId);
    const isEquip = zone.type === 'EQUIP';
    const perpX = -frame.outZ;
    const perpZ = frame.outX;
    const side = isEquip ? 1 : -1;
    const limit = Math.min(items.length, 4);

    for (let i = 0; i < limit; i++) {
      const entity = items[i];
      const face = entity.components?.cardFace || { title: 'Card' };
      const mesh = CardMeshBuilder.createCardMesh(face, 0.78, 1.16, !!entity.isMasked);
      const offset = 1.9 + i * 0.55;

      mesh.position.set(
        frame.x + perpX * side * offset - frame.outX * 0.4,
        0.12,
        frame.z + perpZ * side * offset - frame.outZ * 0.4
      );
      mesh.rotation.y = frame.facing;
      this.applyCardVisualOffset(entity.id, mesh);
      this.boardObjectsGroup.add(mesh);
      this.entityMeshes.set(entity.id, mesh);
      this.raycaster.registerInteractive(mesh, { type: 'ENTITY', id: entity.id, metadata: face });
    }

    const label = this.createLabelSprite(isEquip ? '装备' : '判定区', '#c9b57a', 36);
    label.position.set(
      frame.x + perpX * side * 2.05 - frame.outX * 1.4,
      0.7,
      frame.z + perpZ * side * 2.05 - frame.outZ * 1.4
    );
    label.scale.set(1.5, 0.42, 1);
    this.boardObjectsGroup.add(label);
  }

  /* ------------------------------------------------------------------ */
  /* Table dressing per game                                             */
  /* ------------------------------------------------------------------ */

  private renderGameDecor(state: ProjectedGameState): void {
    if (state.gameId === 'sanguosha') {
      this.addTableMat(9.6, 7.4, 0, -0.2);
      const title = this.createLabelSprite('SANGUOSHA · 三国杀', '#c9b57a', 40);
      title.position.set(0, 0.5, 2.4);
      title.scale.set(4.4, 0.72, 1);
      this.boardObjectsGroup.add(title);
    }

    if (state.gameId === 'splendor') {
      this.addTableMat(10.2, 7.6, 0.2, 0.1);
      this.addTableMat(2.3, 6.2, -7.6, 0.1);
      const title = this.createLabelSprite('DEVELOPMENT MARKET · 发展卡市场', '#c9b57a', 38);
      title.position.set(0.2, 0.5, -3.9);
      title.scale.set(5.2, 0.68, 1);
      this.boardObjectsGroup.add(title);

      // Gem bank tray
      this.addTableMat(2.4, 7.0, 7.6, 0.1);
    }

    if (state.gameId === 'catan') {
      const ports = (state.globalVars.ports ?? []) as {
        position: [number, number, number];
        type: string;
        resource?: string;
      }[];

      for (const port of ports) {
        const resLabel: Record<string, string> = {
          wood: '木材',
          brick: '砖',
          sheep: '羊毛',
          wheat: '麦',
          ore: '矿'
        };
        const text = port.resource ? `${port.type} ${resLabel[port.resource] ?? port.resource}` : port.type;
        const label = this.createLabelSprite(text, port.type === '2:1' ? '#f6dc9c' : '#cbd5e1', 44);
        label.position.set(port.position[0], 0.42, port.position[2]);
        label.scale.set(2.1, 0.46, 1);
        this.boardObjectsGroup.add(label);
      }

      const title = this.createLabelSprite('CATAN · 卡坦岛', '#c9b57a', 38);
      title.position.set(0, 0.5, -6.6);
      title.scale.set(3.6, 0.62, 1);
      this.boardObjectsGroup.add(title);
    }

    if (state.gameId === 'dune_mahjong') {
      this.renderDuneDecor(state);
    }

    if (state.gameId === 'betrayal') {
      const anchors = this.floorAnchorsFor(state, this.lastPlacement);
      const labels: [string, string][] = [
        ['BASEMENT', '地下室 · BASEMENT'],
        ['GROUND', '一楼 · GROUND'],
        ['UPPER', '二楼 · UPPER']
      ];
      for (const [key, text] of labels) {
        const anchor = anchors[key];
        if (!anchor) continue;
        this.addTableMat(anchor.width + 2, anchor.depth + 2, anchor.x, anchor.z, key);
        const plate = this.createLabelSprite(text, key === 'BASEMENT' ? '#a9c2d8' : key === 'UPPER' ? '#cbb4e8' : '#e0c98a', 34);
        plate.position.set(anchor.x, 0.55, anchor.z + anchor.depth / 2 + 1.3);
        plate.scale.set(6.4, 0.78, 1);
        plate.userData.floor = key;
        this.boardObjectsGroup.add(plate);
      }

      const title = this.createLabelSprite('BETRAYAL · 山屋惊魂', '#c9b57a', 38);
      title.position.set(0, 0.5, 9.8);
      title.scale.set(5.4, 0.66, 1);
      this.boardObjectsGroup.add(title);

      const roomDeckCount = state.zones.zone_room_deck?.orderedEntities.length ?? 0;
      const roomDeckLabel = this.createLabelSprite(`房间板块堆 · ${roomDeckCount}`, '#cbb57a', 34);
      roomDeckLabel.position.set(-12, 0.55, 7.4);
      roomDeckLabel.scale.set(3.4, 0.5, 1);
      this.boardObjectsGroup.add(roomDeckLabel);

      if (state.globalVars.hauntTriggered) {
        const haunt = state.globalVars.haunt as { revealRoomId?: string } | null;
        const room = haunt?.revealRoomId ? state.mapGraph.nodes[haunt.revealRoomId] : undefined;
        const sigil = new THREE.Mesh(
          new THREE.TorusGeometry(1.55, 0.05, 8, 48),
          new THREE.MeshStandardMaterial({ color: 0xd50000, emissive: 0xd50000, emissiveIntensity: 0.9, roughness: 0.4 })
        );
        sigil.rotation.x = -Math.PI / 2;
        sigil.position.set(room?.position[0] ?? 0, 0.08, room?.position[2] ?? 0);
        if (room?.props?.floor) sigil.userData.floor = String(room.props.floor);
        this.boardObjectsGroup.add(sigil);
      }
    }
  }

  private floorAnchorsFor(
    state: ProjectedGameState,
    placement?: PlacementPreview
  ): Record<string, { x: number; z: number; width: number; depth: number }> {
    const activePlacement = placement ?? this.lastPlacement;
    const groups = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number }>();
    for (const node of Object.values(state.mapGraph.nodes)) {
      if (node.type !== 'ROOM') continue;
      const floor = String(node.props?.floor ?? '');
      if (!floor) continue;
      const range = groups.get(floor) ?? { minX: node.position[0], maxX: node.position[0], minZ: node.position[2], maxZ: node.position[2] };
      range.minX = Math.min(range.minX, node.position[0]);
      range.maxX = Math.max(range.maxX, node.position[0]);
      range.minZ = Math.min(range.minZ, node.position[2]);
      range.maxZ = Math.max(range.maxZ, node.position[2]);
      groups.set(floor, range);
    }
    if (activePlacement && activePlacement.floor && activePlacement.position) {
      const floor = activePlacement.floor;
      const range = groups.get(floor) ?? {
        minX: activePlacement.position[0],
        maxX: activePlacement.position[0],
        minZ: activePlacement.position[2],
        maxZ: activePlacement.position[2]
      };
      range.minX = Math.min(range.minX, activePlacement.position[0]);
      range.maxX = Math.max(range.maxX, activePlacement.position[0]);
      range.minZ = Math.min(range.minZ, activePlacement.position[2]);
      range.maxZ = Math.max(range.maxZ, activePlacement.position[2]);
      groups.set(floor, range);
    }
    const anchors: Record<string, { x: number; z: number; width: number; depth: number }> = {};
    for (const [floor, range] of groups) {
      anchors[floor] = {
        x: (range.minX + range.maxX) / 2,
        z: (range.minZ + range.maxZ) / 2,
        width: Math.max(12.6, range.maxX - range.minX + 2.84),
        depth: Math.max(8, range.maxZ - range.minZ + 2.84)
      };
    }
    return anchors;
  }

  /** Dark inset mat with a thin brass outline, used to frame card areas. */
  private addTableMat(width: number, depth: number, x: number, z: number, floor?: string): void {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.02, depth),
      new THREE.MeshStandardMaterial({ color: 0x0a1712, roughness: 0.96, metalness: 0.02 })
    );
    plate.position.set(x, 0.012, z);
    plate.receiveShadow = true;
    if (floor) plate.userData.floor = floor;
    this.boardObjectsGroup.add(plate);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(plate.geometry),
      new THREE.LineBasicMaterial({ color: 0xc9a24a, transparent: true, opacity: 0.4 })
    );
    edges.position.set(x, 0.024, z);
    if (floor) edges.userData.floor = floor;
    this.boardObjectsGroup.add(edges);
  }

  private renderDuneDecor(state: ProjectedGameState): void {
    // Sand arena floor
    const sandTex = this.createSandTexture();
    const inner = new THREE.Mesh(
      new THREE.CircleGeometry(4.4, 72),
      new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95, metalness: 0.02 })
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.03;
    inner.receiveShadow = true;
    this.boardObjectsGroup.add(inner);

    const arena = new THREE.Mesh(
      new THREE.TorusGeometry(4.42, 0.06, 10, 96),
      new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.85, roughness: 0.28 })
    );
    arena.rotation.x = -Math.PI / 2;
    arena.position.y = 0.05;
    this.boardObjectsGroup.add(arena);

    // Radial ticks around the wheel
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.012, i % 3 === 0 ? 0.42 : 0.22),
        new THREE.MeshStandardMaterial({ color: 0x8a6a2f, roughness: 0.6 })
      );
      tick.position.set(Math.cos(a) * 4.15, 0.045, Math.sin(a) * 4.15);
      tick.rotation.y = -a;
      this.boardObjectsGroup.add(tick);
    }

    // Spice tokens clustered at the centre
    for (let i = 0; i < 16; i++) {
      const a = i * 0.82;
      const r = 0.55 + (i % 4) * 0.5;
      const spice = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.17, 0),
        new THREE.MeshStandardMaterial({
          color: 0xe0922f,
          emissive: 0x6b3f0a,
          emissiveIntensity: 0.55,
          roughness: 0.32,
          metalness: 0.45
        })
      );
      spice.position.set(Math.cos(a) * r, 0.15 + (i % 3) * 0.05, Math.sin(a) * r);
      spice.rotation.set(i, i * 1.7, i * 0.6);
      spice.castShadow = true;
      this.boardObjectsGroup.add(spice);
    }

    // Two battle dials
    const dials: { id: string; x: number; color: string; label: string; troops: number }[] = [
      { id: 'p1', x: -5.9, color: '#2e7d32', label: 'ATREIDES', troops: state.players.p1?.customProps.troops ?? 8 },
      { id: 'p2', x: 5.9, color: '#c62828', label: 'HARKONNEN', troops: state.players.p2?.customProps.troops ?? 10 }
    ];

    dials.forEach(dial => {
      const committed = !!state.globalVars.committedDials?.[dial.id];

      const outer = new THREE.Mesh(
        new THREE.CylinderGeometry(1.25, 1.3, 0.08, 48),
        new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.6, metalness: 0.3 })
      );
      outer.position.set(dial.x, 0.06, 3.4);
      outer.receiveShadow = true;
      this.boardObjectsGroup.add(outer);

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.02, 1.02, 0.1, 48),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(dial.color),
          roughness: 0.4,
          metalness: 0.3,
          emissive: new THREE.Color(dial.color),
          emissiveIntensity: committed ? 0.55 : 0.08
        })
      );
      base.position.set(dial.x, 0.11, 3.4);
      this.boardObjectsGroup.add(base);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(1.14, 0.035, 8, 48),
        new THREE.MeshStandardMaterial({
          color: committed ? 0xf6dc9c : 0x8a6a2f,
          emissive: committed ? 0xd9b45b : 0x000000,
          emissiveIntensity: committed ? 0.9 : 0,
          metalness: 0.85,
          roughness: 0.3
        })
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(dial.x, 0.17, 3.4);
      this.boardObjectsGroup.add(rim);

      // Troop pips
      for (let i = 0; i < Math.min(dial.troops, 10); i++) {
        const a = (i / 10) * Math.PI * 2;
        const pip = new THREE.Mesh(
          new THREE.SphereGeometry(0.075, 8, 8),
          new THREE.MeshStandardMaterial({ color: 0xf0e6cf, roughness: 0.5 })
        );
        pip.position.set(dial.x + Math.cos(a) * 0.86, 0.19, 3.4 + Math.sin(a) * 0.86);
        this.boardObjectsGroup.add(pip);
      }

      const glyph = this.createLabelSprite(committed ? `LOCKED · ${dial.label}` : dial.label, committed ? '#f6dc9c' : '#cfd8e6', 44);
      glyph.position.set(dial.x, 0.72, 3.4);
      glyph.scale.set(2.6, 0.72, 1);
      this.boardObjectsGroup.add(glyph);
    });

    // Mahjong mode: tile + pond
    if (state.globalVars.battleMode === 'MAHJONG') {
      const tileTex = this.createMahjongTileTexture();
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 0.26, 1.45),
        [
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.55 }),
          new THREE.MeshStandardMaterial({ color: 0xe4dfd2, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
          new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 })
        ]
      );
      tile.position.set(0, 0.15, 0.2);
      tile.rotation.y = 0.35;
      tile.castShadow = true;
      this.boardObjectsGroup.add(tile);

      const label = this.createLabelSprite('PRIORITY CLAIM · 吃 / 碰 / 胡', '#f6dc9c', 42);
      label.position.set(0, 0.95, 5.5);
      label.scale.set(4.6, 0.7, 1);
      this.boardObjectsGroup.add(label);
    } else {
      const title = this.createLabelSprite('SIMULTANEOUS BATTLE WHEEL', '#d8c9a0', 38);
      title.position.set(0, 0.8, -5.3);
      title.scale.set(4.6, 0.66, 1);
      this.boardObjectsGroup.add(title);
    }
  }

  /** Procedural sand texture for the Arrakis battle wheel. */
  private createSandTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(256, 256, 40, 256, 256, 300);
    grad.addColorStop(0, '#c9a367');
    grad.addColorStop(0.55, '#b58a4e');
    grad.addColorStop(1, '#8d6535');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);

    // Ripples
    ctx.strokeStyle = 'rgba(90, 62, 30, 0.18)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.arc(256, 256, 26 + i * 9, 0.15 * i, 0.15 * i + 2.2);
      ctx.stroke();
    }

    // Grain
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const a = Math.random() * 0.09;
      ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,236,196,${a})` : `rgba(80,54,24,${a})`;
      ctx.fillRect(x, y, 2, 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private createMahjongTileTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 340;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#f6f2e6';
    ctx.fillRect(0, 0, 256, 340);
    ctx.strokeStyle = '#cfc7b3';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, 236, 320);

    // 9 bamboo sticks, stylised
    ctx.fillStyle = '#1f8a4c';
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = 46 + col * 58;
        const y = 62 + row * 72;
        ctx.fillRect(x, y, 16, 48);
        ctx.beginPath();
        ctx.arc(x + 8, y - 4, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#2f6b4f';
    ctx.font = `700 30px ${CANVAS_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('九条', 128, 318);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private createLabelSprite(text: string, color = '#ffffff', fontSize = 52): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = 'rgba(10,13,19,0.72)';
    ctx.beginPath();
    ctx.roundRect(12, 36, 1000, 184, 40);
    ctx.fill();

    ctx.strokeStyle = 'rgba(217,180,91,0.45)';
    ctx.lineWidth = 4;
    ctx.stroke();

    const scale = 2;
    const scaledFontSize = fontSize * scale;
    ctx.font = `600 ${scaledFontSize}px ${CANVAS_FONT_STACK}`;
    let fitted = scaledFontSize;
    while (ctx.measureText(text).width > 920 && fitted > 28) {
      fitted -= 4;
      ctx.font = `600 ${fitted}px ${CANVAS_FONT_STACK}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.userData.ownedTexture = true;
    return sprite;
  }

  private applyCardVisualOffset(entityId: string, mesh: THREE.Object3D): void {
    const offset = this.cardVisualOffsets.get(entityId);
    if (!offset) return;
    mesh.position.x += offset.dx;
    mesh.position.z += offset.dz;
  }

  private renderCardEntity(
    entity: Partial<Entity> & { isMasked?: boolean; id: string },
    zone: ProjectedGameState['zones'][string],
    index: number,
    totalInZone: number,
    interactive = true
  ): void {
    const face = entity.components?.cardFace || { title: 'Card' };
    const isMasked = !!entity.isMasked;
    const custom = entity.components?.custom as Record<string, unknown> | undefined;
    const isPkmn = this.lastState?.gameId === 'splendor';
    const mesh = CardMeshBuilder.createCardMesh(
      face,
      1.35,
      2.0,
      isMasked,
      isPkmn ? pokemonCardTexture(custom) : null,
      isPkmn ? pokemonCardBackTexture(custom) : null
    );

    if (zone.id === 'zone_market_t1') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, 2.5);
      mesh.rotation.y = 0;
    } else if (zone.id === 'zone_market_t2') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, 0.1);
      mesh.rotation.y = 0;
    } else if (zone.id === 'zone_market_t3') {
      mesh.position.set(-3.9 + index * 1.52, 0.1, -2.3);
      mesh.rotation.y = 0;
    } else if (zone.id.startsWith('zone_tableau_')) {
      mesh.position.set(-9.4 + (index % 5) * 0.72, 0.1 + index * 0.012, 3.2 + Math.floor(index / 5) * 0.78);
      mesh.scale.set(0.55, 0.55, 0.55);
      mesh.rotation.y = 0;
    } else if (zone.type === 'BOARD') {
      const roomId = zone.id.startsWith('zone_room_') ? zone.id.slice('zone_room_'.length) : '';
      const roomNode = roomId ? this.lastState?.mapGraph.nodes[roomId] : undefined;
      if (roomNode?.props?.floor) mesh.userData.floor = String(roomNode.props.floor);
      const anchor = roomNode
        ? [roomNode.position[0], roomNode.position[1] + 0.16, roomNode.position[2]]
        : zone.anchorPosition ?? [0, 0.16, 0];
      if (zone.id.startsWith('zone_room_')) {
        // The module-owned slot is the single source of truth for the item
        // anchor, layout, scale and layer height. The renderer only converts
        // that contract into world coordinates.
        const slot = Object.values(this.lastState?.mapGraph.slots ?? {}).find(
          candidate =>
            candidate.nodeId === roomId &&
            (!candidate.accepts?.entityTypes || candidate.accepts.entityTypes.includes('CARD'))
        );
        const local = slot?.local?.position ?? [0.38, 0.16, 0.48];
        const base = roomNode
          ? [roomNode.position[0] + local[0], roomNode.position[1] + local[1], roomNode.position[2] + local[2]]
          : [anchor[0] + local[0], anchor[1] + local[1], anchor[2] + local[2]];
        const layout = slot?.layout ?? (totalInZone > 1 ? 'FAN' : 'STACK');
        const scale = slot?.visual?.scale ?? 0.3;
        const gap = slot?.visual?.gap ?? 0.58;
        const layerHeight = slot?.visual?.height ?? 0.01;
        const spread = (index - (totalInZone - 1) / 2) * gap;
        mesh.scale.set(scale, scale, scale);
        if (layout === 'FAN') {
          mesh.position.set(base[0] + spread, base[1], base[2]);
          mesh.rotation.y = spread * 0.35;
        } else if (layout === 'STACK') {
          mesh.position.set(base[0], base[1] + index * layerHeight, base[2]);
          mesh.rotation.y = 0.18;
        } else {
          mesh.position.set(base[0] + spread, base[1], base[2]);
          mesh.rotation.y = 0;
        }
      } else {
        const shown = Math.min(totalInZone, 4);
        mesh.scale.set(0.34, 0.34, 0.34);
        mesh.position.set(anchor[0] + (index - (shown - 1) / 2) * 0.62, anchor[1], anchor[2] + 0.85);
        mesh.rotation.y = 0;
      }
    } else if (zone.type === 'HAND' && zone.anchorPosition) {
      const anchor = zone.anchorPosition;
      const shown = Math.min(totalInZone, 7);
      mesh.scale.set(0.62, 0.62, 0.62);
      mesh.position.set(anchor[0] + (index - (shown - 1) / 2) * 0.9, anchor[1], anchor[2]);
      mesh.rotation.y = 0;
    } else {
      mesh.position.set((index - totalInZone / 2) * 1.5, 0.1, 0);
      mesh.rotation.y = 0;
    }

    this.applyCardVisualOffset(entity.id, mesh);
    this.boardObjectsGroup.add(mesh);
    this.entityMeshes.set(entity.id, mesh);
    if (interactive) {
      this.raycaster.registerInteractive(mesh, {
        type: 'ENTITY',
        id: entity.id,
        metadata: face
      });
    }
  }

  private onResize(): void {
    if (!this.container || this.isDestroyed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private renderLoop(): void {
    if (this.isDestroyed) return;
    requestAnimationFrame(this.renderLoop.bind(this));

    this.controls.update();
    this.animQueue.update();
    const now = performance.now();
    this.updateCameraTween(now);
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.physics.step(dt);
    this.updateFocusLight();
    this.updateCardSettles(now);
    this.updateRoomSettles(now);
    this.updateNavArrows(now);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(
      this.camera,
      { width: this.container.clientWidth, height: this.container.clientHeight },
      this.labelObstacles()
    );
  }

  public destroy(): void {
    this.isDestroyed = true;
    window.removeEventListener('resize', this.onResize.bind(this));
    this.clearBoardObjects();
    this.labels.destroy();
    this.physics.dispose();
    this.renderer.dispose();
  }
}
