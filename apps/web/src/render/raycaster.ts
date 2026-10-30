import * as THREE from 'three';

export interface InteractiveObjectData {
  type: 'ENTITY' | 'NODE' | 'EDGE' | 'DICE';
  id: string;
  metadata?: any;
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
  private onEntityPressCallback?: (entityId: string) => void;
  private pointerDownData: InteractiveObjectData | null = null;
  private pointerDownAt: { x: number; y: number } | null = null;
  private dragging = false;

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.domElement.addEventListener('pointermove', this.onPointerMove.bind(this));
    this.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this));
    this.domElement.addEventListener('pointerup', this.onPointerUp.bind(this));
    this.domElement.addEventListener('pointercancel', this.onPointerCancel.bind(this));
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
  public onEntityPress(callback: (entityId: string) => void): void {
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
        const wasDragging = this.dragging;
        this.dragging = true;
        this.domElement.style.cursor = 'grabbing';
        if (!wasDragging && this.pointerDownData?.type === 'ENTITY') {
          this.onDragStartCallback?.(this.pointerDownData.id);
        }
        if (this.dragging && this.pointerDownData?.type === 'ENTITY') {
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
        this.domElement.style.cursor = 'pointer';
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

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return; // Only primary click
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
    this.dragging = false;
    this.pointerDownData = this.pickAt(event.clientX, event.clientY);

    if (this.pointerDownData?.type === 'ENTITY') {
      // Stop OrbitControls from consuming the first few pixels before the
      // drag threshold is crossed.
      this.onEntityPressCallback?.(this.pointerDownData.id);
    }

    // Capturing an entity drag keeps pointermove/pointerup flowing even when
    // the cursor leaves the canvas or is released over the HUD. Without this,
    // the drop callback never runs, the card stays at its lifted height and
    // OrbitControls can remain disabled.
    if (this.pointerDownData?.type === 'ENTITY') {
      try {
        this.domElement.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is not available for synthetic/older pointers.
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
      const target = this.pickAt(event.clientX, event.clientY);
      this.onDropCallback?.(data.id, target, event.clientX, event.clientY);
      this.domElement.style.cursor = 'default';
    } else if (this.onClickCallback) {
      this.onClickCallback(data);
    }
    if (this.dragging) this.onDragEndCallback?.();
    this.dragging = false;
  }

  private onPointerCancel(event: PointerEvent): void {
    try {
      if (this.domElement.hasPointerCapture(event.pointerId)) {
        this.domElement.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }
    if (this.dragging) this.onDragEndCallback?.();
    this.pointerDownData = null;
    this.pointerDownAt = null;
    this.dragging = false;
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
