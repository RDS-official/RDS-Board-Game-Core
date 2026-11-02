import * as THREE from 'three';

/**
 * Luxury 3D game table.
 * All materials are procedurally generated at runtime (canvas textures),
 * so the scene has zero external asset dependencies.
 */
export const TABLE_SIZE = { width: 33, length: 24 } as const;

export class GameTableBuilder {
  private static feltTexture: THREE.CanvasTexture | null = null;
  private static woodTexture: THREE.CanvasTexture | null = null;

  private static createFeltTexture(): THREE.CanvasTexture {
    if (this.feltTexture) return this.feltTexture;

    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Base: deep casino velvet
    const base = ctx.createRadialGradient(size / 2, size / 2, 40, size / 2, size / 2, size * 0.72);
    base.addColorStop(0, '#1a3327');
    base.addColorStop(0.55, '#132619');
    base.addColorStop(1, '#0b1710');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    // Woven fibre noise
    for (let i = 0; i < 22000; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const a = Math.random() * 0.05;
      ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.6})`;
      ctx.fillRect(x, y, 1.6, 1.6);
    }

    // Fine herringbone weave lines
    ctx.strokeStyle = 'rgba(255,255,255,0.014)';
    ctx.lineWidth = 1;
    for (let x = -size; x < size * 2; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + size, size);
      ctx.stroke();
    }

    // Gold emblem ring in the centre, very subtle
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.strokeStyle = 'rgba(217,180,91,0.10)';
    ctx.lineWidth = 3;
    [200, 214].forEach(r => {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // 12 ticks around the ring
    ctx.strokeStyle = 'rgba(217,180,91,0.13)';
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const long = i % 2 === 0;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * (long ? 196 : 202), Math.sin(angle) * (long ? 196 : 202));
      ctx.lineTo(Math.cos(angle) * 214, Math.sin(angle) * 214);
      ctx.stroke();
    }

    // Monogram
    ctx.fillStyle = 'rgba(217,180,91,0.075)';
    ctx.font = 'italic 210px "Iowan Old Style", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('𝒢', 0, 12);
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.feltTexture = texture;
    return texture;
  }

  private static createWoodTexture(): THREE.CanvasTexture {
    if (this.woodTexture) return this.woodTexture;

    const w = 1024;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Mahogany gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#4a2418');
    grad.addColorStop(0.35, '#3a1b12');
    grad.addColorStop(0.7, '#2e140d');
    grad.addColorStop(1, '#1f0d08');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Grain streaks
    for (let i = 0; i < 260; i++) {
      const y = Math.random() * h;
      const alpha = 0.02 + Math.random() * 0.05;
      ctx.strokeStyle = Math.random() > 0.5 ? `rgba(255,190,140,${alpha})` : `rgba(0,0,0,${alpha * 1.4})`;
      ctx.lineWidth = 0.6 + Math.random() * 2.2;
      ctx.beginPath();
      let px = -20;
      let py = y;
      ctx.moveTo(px, py);
      while (px < w + 20) {
        px += 18 + Math.random() * 26;
        py = y + Math.sin(px * 0.012 + i) * (1.5 + Math.random() * 3.5);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Satin sheen band
    const sheen = ctx.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255,220,180,0.10)');
    sheen.addColorStop(0.5, 'rgba(255,220,180,0.015)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 1);
    this.woodTexture = texture;
    return texture;
  }


  public static createTable(width = TABLE_SIZE.width, length = TABLE_SIZE.length): THREE.Group {
    const tableGroup = new THREE.Group();

    // ---------- Felt surface ----------
    const feltGeom = new THREE.BoxGeometry(width - 1.1, 0.42, length - 1.1);
    const feltMat = new THREE.MeshStandardMaterial({
      map: this.createFeltTexture(),
      roughness: 0.97,
      metalness: 0.02
    });
    const feltMesh = new THREE.Mesh(feltGeom, feltMat);
    feltMesh.position.y = -0.21;
    feltMesh.receiveShadow = true;
    tableGroup.add(feltMesh);

    // Inner gold pinstripe around the playing surface
    const pinstripeMat = new THREE.MeshStandardMaterial({
      color: 0x8a6a2f,
      roughness: 0.35,
      metalness: 0.8
    });
    const pinW = width - 2.2;
    const pinL = length - 2.2;
    const addStripe = (w: number, d: number, x: number, z: number) => {
      const g = new THREE.BoxGeometry(w, 0.02, d);
      const m = new THREE.Mesh(g, pinstripeMat);
      m.position.set(x, 0.005, z);
      tableGroup.add(m);
    };
    addStripe(pinW, 0.03, 0, -pinL / 2);
    addStripe(pinW, 0.03, 0, pinL / 2);
    addStripe(0.03, pinL, -pinW / 2, 0);
    addStripe(0.03, pinL, pinW / 2, 0);

    // ---------- Wooden rim ----------
    const woodTex = this.createWoodTexture();
    const rimMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.22
    });

    const rimH = 0.62;
    const rimW = 1.05;

    const northRim = new THREE.Mesh(new THREE.BoxGeometry(width, rimH, rimW), rimMat);
    northRim.position.set(0, -0.12, -(length / 2 - rimW / 2));
    northRim.castShadow = true;
    northRim.receiveShadow = true;
    tableGroup.add(northRim);

    const southRim = northRim.clone();
    southRim.position.z = length / 2 - rimW / 2;
    tableGroup.add(southRim);

    const westRim = new THREE.Mesh(new THREE.BoxGeometry(rimW, rimH, length), rimMat);
    westRim.position.set(-(width / 2 - rimW / 2), -0.12, 0);
    westRim.castShadow = true;
    westRim.receiveShadow = true;
    tableGroup.add(westRim);

    const eastRim = westRim.clone();
    eastRim.position.x = width / 2 - rimW / 2;
    tableGroup.add(eastRim);

    // ---------- Brass corner inlays ----------
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xc9a355,
      roughness: 0.22,
      metalness: 0.9
    });

    const corners: [number, number][] = [
      [-width / 2 + rimW / 2, -length / 2 + rimW / 2],
      [width / 2 - rimW / 2, -length / 2 + rimW / 2],
      [-width / 2 + rimW / 2, length / 2 - rimW / 2],
      [width / 2 - rimW / 2, length / 2 - rimW / 2]
    ];

    corners.forEach(([cx, cz]) => {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, rimH + 0.04, 20), brassMat);
      plate.position.set(cx, -0.11, cz);
      plate.castShadow = true;
      tableGroup.add(plate);
    });

    // ---------- Studio floor ----------
    const floorGeom = new THREE.PlaneGeometry(90, 90);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x07090d,
      roughness: 0.94,
      metalness: 0.08
    });
    const floorMesh = new THREE.Mesh(floorGeom, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -3.6;
    floorMesh.receiveShadow = true;
    tableGroup.add(floorMesh);

    return tableGroup;
  }
}
