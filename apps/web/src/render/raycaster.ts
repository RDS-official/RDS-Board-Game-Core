import * as THREE from 'three';

export interface InteractiveObjectData {
  type: 'ENTITY' | 'NODE' | 'EDGE' | 'DICE' | 'ZONE';
  id: string;
  /** 节点自定义元数据，由场景构建方写入；消费处按需收窄（issue #234）。 */
  metadata?: unknown;
}

export class BoardRaycaster {
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private camera: THREE.Camera;
  private domElement: HTMLElement;
  private interactiveMeshes = new Map<THREE.Object3D, InteractiveObjectData>();
  private hoveredObject: THREE.Object3D | null = null;
  private originalEmissive = new Map<THREE.Material, THREE.Color>();
  /** Mesh → its original material(s), so hover copies can be swapped back. */
  private ownedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** Cloned hover materials that this raycaster owns and must dispose. */
  private tintedClones = new Set<THREE.Material>();

  private onClickCallback?: (data: InteractiveObjectData) => void;
  private onHoverCallback?: (data: InteractiveObjectData | null) => void;
  private onDropCallback?: (
    entityId: string,
    target: InteractiveObjectData | null,
    clientX: number,
    clientY: number
  ) => void;
  private onDragStartCallback?: (entityId: string) => void;
  private onDragEndCallback?: () => void;
  private onDragMoveCallback?: (entityId: string, clientX: number, clientY: number) => void;
  private onEntityPressCallback?: (data: InteractiveObjectData) => void;
  private pointerDownData: InteractiveObjectData | null = null;
  private pointerDownAt: { x: number; y: number } | null = null;
  private dragging = false;
  /** Any 6px+ move after a press, even when the surface is not draggable. */
  private pointerMoved = false;
  /** This press must keep the camera still (a drag prop or a locked surface). */
  private pointerPressedLocked = false;

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.domElement.addEventListener('pointermove', this.onPointerMove.bind(this));
    this.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this));
    this.domElement.addEventListener('pointerup', this.onPointerUp.bind(this));
    this.domElement.addEventListener('pointercancel', this.onPointerCancel.bind(this));
    // Hover is recomputed on `pointermove` only, so a pointer that leaves the
    // canvas (or the window) used to keep the last hovered object tinted and its
    // preview window on screen until the pointer came back and moved again.
    this.domElement.addEventListener('pointerleave', this.onPointerLeave.bind(this));
  }

  public registerInteractive(object: THREE.Object3D, data: InteractiveObjectData): void {
    object.traverse(child => {
      if ((child as THREE.Mesh).isMesh) {
        this.interactiveMeshes.set(child, data);
      }
    });
    this.interactiveMeshes.set(object, data);
  }

  public clearInteractive(): void {
    this.interactiveMeshes.clear();
    this.hoveredObject = null;
  }

  public onClick(callback: (data: InteractiveObjectData) => void): void {
    this.onClickCallback = callback;
  }

  public onHover(callback: (data: InteractiveObjectData | null) => void): void {
    this.onHoverCallback = callback;
  }

  public onDrop(
    callback: (entityId: string, target: InteractiveObjectData | null, clientX: number, clientY: number) => void
  ): void {
    this.onDropCallback = callback;
  }

  public onDragStart(callback: (entityId: string) => void): void {
    this.onDragStartCallback = callback;
  }

  /** Fires immediately on pointerdown over an entity, before the 6px drag threshold. */
  public onEntityPress(callback: (data: InteractiveObjectData) => void): void {
    this.onEntityPressCallback = callback;
  }

  public onDragEnd(callback: () => void): void {
    this.onDragEndCallback = callback;
  }

  public onDragMove(
    callback: (entityId: string, clientX: number, clientY: number) => void
  ): void {
    this.onDragMoveCallback = callback;
  }

  private isHierarchyVisible(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  private pickAt(clientX: number, clientY: number): InteractiveObjectData | null {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = Array.from(this.interactiveMeshes.keys()).filter(m => this.isHierarchyVisible(m));
    const intersects = this.raycaster.intersectObjects(meshes, false);
    if (intersects.length === 0) return null;
    return this.interactiveMeshes.get(intersects[0].object) ?? null;
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.pointerDownAt && event.buttons === 1) {
      const distance = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y);
      if (distance >= 6) {
        this.pointerMoved = true;
        const wasDragging = this.dragging;
        this.dragging = true;
        this.domElement.style.cursor = 'grabbing';
        if (!wasDragging && this.isDraggable(this.pointerDownData)) {
          this.onDragStartCallback?.(this.pointerDownData.id);
        }
        if (this.dragging && this.isDraggable(this.pointerDownData)) {
          this.onDragMoveCallback?.(this.pointerDownData.id, event.clientX, event.clientY);
        }
      }
    }
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = Array.from(this.interactiveMeshes.keys()).filter(m => this.isHierarchyVisible(m));
    const intersects = this.raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      const topHit = intersects[0].object;
      const data = this.interactiveMeshes.get(topHit);

      if (this.hoveredObject !== topHit) {
        this.resetHover();
        this.hoveredObject = topHit;
        this.applyHoverHighlight(topHit);
        this.domElement.style.cursor = data?.type === 'ZONE' ? 'grab' : 'pointer';
        if (this.onHoverCallback) this.onHoverCallback(data || null);
      }
    } else {
      if (this.hoveredObject) {
        this.resetHover();
        this.domElement.style.cursor = 'default';
        if (this.onHoverCallback) this.onHoverCallback(null);
      }
    }
  }

  private isDraggable(data: InteractiveObjectData | null): data is InteractiveObjectData {
    // A surface can opt out of dragging while staying clickable (the viewer's
    // own hand is a read-only overlay: details on click, never a drag prop).
    if ((data?.metadata as { draggable?: boolean } | undefined)?.draggable === false) return false;
    return data?.type === 'ENTITY' || data?.type === 'ZONE';
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return; // Only primary click
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
    this.pointerMoved = false;
    this.dragging = false;
    this.pointerDownData = this.pickAt(event.clientX, event.clientY);
    this.pointerPressedLocked = false;

    if (this.pointerDownData) {
      const meta = this.pointerDownData.metadata as { orbitLock?: boolean } | undefined;
      this.pointerPressedLocked = this.isDraggable(this.pointerDownData) || meta?.orbitLock === true;
      this.onEntityPressCallback?.(this.pointerDownData);
      if (this.pointerPressedLocked) {
        // Stop OrbitControls from consuming the first few pixels. Capturing
        // keeps the matching release flowing even when the pointer leaves the
        // canvas, so OrbitControls can never be left disabled.
        try {
          this.domElement.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is not available for synthetic/older pointers.
        }
      }
    }
  }

  private onPointerUp(event: PointerEvent): void {
    const data = this.pointerDownData;
    const start = this.pointerDownAt;
    this.pointerDownData = null;
    this.pointerDownAt = null;

    try {
      if (this.domElement.hasPointerCapture(event.pointerId)) {
        this.domElement.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }

    if (!data || !start) return;

    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (this.dragging && distance >= 6) {
      // A ZONE drag is a pure presentation gesture. It must not fall through to
      // the entity drop/click path (which would open a detail sheet mid-drag).
      if (data.type !== 'ZONE') {
        const target = this.pickAt(event.clientX, event.clientY);
        this.onDropCallback?.(data.id, target, event.clientX, event.clientY);
      }
      this.domElement.style.cursor = data.type === 'ZONE' ? 'grab' : 'default';
    } else if (!this.pointerMoved && data.type !== 'ZONE' && this.onClickCallback) {
      // A press-and-drag on a read-only surface (the hand) is a deliberate
      // gesture, not a click: never open a detail sheet on release.
      this.onClickCallback(data);
    }
    // Re-enable the camera whenever the press had locked it, including a
    // read-only hand press that never became a drag.
    if (data && (this.dragging || this.pointerPressedLocked)) this.onDragEndCallback?.();
    this.dragging = false;
    this.pointerMoved = false;
    this.pointerPressedLocked = false;
  }

  private onPointerCancel(event: PointerEvent): void {
    const hadLock = this.pointerPressedLocked;
    try {
      if (this.domElement.hasPointerCapture(event.pointerId)) {
        this.domElement.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }
    if (hadLock || this.dragging) this.onDragEndCallback?.();
    this.pointerDownData = null;
    this.pointerDownAt = null;
    this.dragging = false;
    this.pointerMoved = false;
    this.pointerPressedLocked = false;
  }

  private applyHoverHighlight(obj: THREE.Object3D): void {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    // Room meshes are merged per material and share the global palette. Tinting
    // those in place would light up every room on the board, so give the hovered
    // mesh private copies and swap them back on hover-out.
    if (Array.isArray(mesh.material)) {
      this.ownedMaterials.set(mesh, mesh.material.slice());
      mesh.material = mesh.material.map(mat => this.tintCopy(mat as THREE.MeshStandardMaterial));
    } else {
      const original = mesh.material as THREE.MeshStandardMaterial;
      this.ownedMaterials.set(mesh, original);
      mesh.material = this.tintCopy(original);
    }
  }

  /** Clone a material, tint its emissive, and remember the clone for disposal. */
  private tintCopy(mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    if (!mat || !mat.emissive) return mat;
    if (mat.userData?.shared) {
      const copy = mat.clone();
      copy.emissive.setHex(0x445588);
      this.tintedClones.add(copy);
      return copy;
    }
    if (!this.originalEmissive.has(mat)) this.originalEmissive.set(mat, mat.emissive.clone());
    mat.emissive.setHex(0x445588);
    return mat;
  }

  private tintMaterial(mat: THREE.MeshStandardMaterial): void {
    if (mat.emissive) {
      if (!this.originalEmissive.has(mat)) {
        this.originalEmissive.set(mat, mat.emissive.clone());
      }
      mat.emissive.setHex(0x445588);
    }
  }

  /**
   * The pointer left the canvas: nothing is hovered any more.
   *
   * Without this the hover state outlived the pointer — a seat plaque or a card
   * chip stayed on screen while the pointer was over a panel or a payload
   * window, and only the next `pointermove` over the board could close it.
   */
  private onPointerLeave(): void {
    if (!this.hoveredObject) return;
    this.resetHover();
    this.domElement.style.cursor = 'default';
    if (this.onHoverCallback) this.onHoverCallback(null);
  }

  private resetHover(): void {
    if (this.hoveredObject && (this.hoveredObject as THREE.Mesh).isMesh) {
      const mesh = this.hoveredObject as THREE.Mesh;
      const original = this.ownedMaterials.get(mesh);
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(mat => { this.disposeTint(mat as THREE.Material); });
      } else {
        this.disposeTint(mesh.material as THREE.Material);
      }
      if (original) {
        mesh.material = original as THREE.Mesh['material'];
        this.ownedMaterials.delete(mesh);
      }
    }
    this.hoveredObject = null;
  }

  /** Free a cloned hover material, or restore an in-place tint. */
  private disposeTint(mat: THREE.Material | undefined): void {
    if (!mat) return;
    if (this.tintedClones.has(mat)) {
      this.tintedClones.delete(mat);
      mat.dispose();
      return;
    }
    this.restoreMaterial(mat as THREE.MeshStandardMaterial);
  }

  private restoreMaterial(mat: THREE.MeshStandardMaterial): void {
    if (mat.emissive && this.originalEmissive.has(mat)) {
      mat.emissive.copy(this.originalEmissive.get(mat)!);
    }
  }
}
