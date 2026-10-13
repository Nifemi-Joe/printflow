"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const EMERALD = "#0a7a55";
const GRAPHITE = "#2b3137";

/** Draws the job ticket that appears on the emerging sheet. */
function useTicketTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 724;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#05402d";
    g.font = "700 40px 'Bricolage Grotesque Variable', sans-serif";
    g.fillText("CSC 201 notes", 44, 92);
    g.fillStyle = "#5a6168";
    g.font = "26px 'Atkinson Hyperlegible', sans-serif";
    g.fillText("24 pages, A4, black & white", 44, 140);
    g.fillText("Double-sided, 1 copy", 44, 176);
    g.strokeStyle = "#d6dbd5";
    g.setLineDash([8, 8]);
    g.lineWidth = 2;
    for (const y of [220, 300, 380]) {
      g.beginPath();
      g.moveTo(44, y);
      g.lineTo(468, y);
      g.stroke();
    }
    g.fillStyle = "#24292e";
    g.font = "26px 'Atkinson Hyperlegible', sans-serif";
    g.fillText("12 sheets", 44, 268);
    g.fillText("₦420.00", 352, 268);
    g.fillText("Service fee", 44, 348);
    g.fillText("₦56.30", 368, 348);
    g.fillStyle = "#05402d";
    g.font = "700 38px 'Bricolage Grotesque Variable', sans-serif";
    g.fillText("Total", 44, 446);
    g.fillText("₦476.30", 312, 446);
    g.fillStyle = EMERALD;
    g.fillRect(44, 540, 424, 96);
    g.fillStyle = "#ffffff";
    g.font = "700 34px 'Bricolage Grotesque Variable', sans-serif";
    g.fillText("Pickup  482 913", 92, 600);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
}

function Printer({ progress }: { progress: React.MutableRefObject<number> }) {
  const sheet = useRef<THREE.Group>(null);
  const led = useRef<THREE.MeshStandardMaterial>(null);
  const ticket = useTicketTexture();
  const eased = useRef(0);

  useFrame((state, delta) => {
    // Damped follow of scroll progress; the sheet feeds out of the slot.
    eased.current += (progress.current - eased.current) * Math.min(1, delta * 4);
    const p = eased.current;
    if (sheet.current) {
      // The sheet slides out of the front face below the lid; its hidden back
      // part stays inside the body, and the front droops slightly as it feeds.
      sheet.current.position.z = 0.95 + p * 0.75;
      sheet.current.position.y = 0.5 - p * 0.06;
      sheet.current.rotation.x = -Math.PI / 2 + 0.04 + p * 0.1;
    }
    if (led.current) led.current.emissiveIntensity = 0.6 + Math.sin(state.clock.elapsedTime * 3) * 0.4;
  });

  return (
    <group rotation={[0.18, -0.55, 0]} position={[0.35, -0.55, -0.2]}>
      {/* body */}
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 0.6, 1.7]} />
        <meshStandardMaterial color={GRAPHITE} roughness={0.55} metalness={0.15} />
      </mesh>
      {/* lid */}
      <mesh position={[0, 0.64, -0.2]} castShadow>
        <boxGeometry args={[2.3, 0.08, 1.2]} />
        <meshStandardMaterial color="#3a4148" roughness={0.4} />
      </mesh>
      {/* output slot */}
      <mesh position={[0, 0.5, 0.852]}>
        <boxGeometry args={[1.45, 0.06, 0.01]} />
        <meshStandardMaterial color="#14181b" roughness={0.9} />
      </mesh>
      {/* control strip with status light */}
      <mesh position={[0.85, 0.62, 0.55]}>
        <boxGeometry args={[0.5, 0.06, 0.3]} />
        <meshStandardMaterial color="#1d2226" />
      </mesh>
      <mesh position={[0.95, 0.66, 0.58]}>
        <sphereGeometry args={[0.035, 16, 16]} />
        <meshStandardMaterial ref={led} color={EMERALD} emissive={EMERALD} emissiveIntensity={1} />
      </mesh>
      {/* the sheet carrying the job ticket */}
      <group ref={sheet} position={[0, 0.5, 0.95]}>
        <mesh castShadow>
          <planeGeometry args={[1.25, 1.77]} />
          <meshStandardMaterial map={ticket} side={THREE.DoubleSide} roughness={0.85} />
        </mesh>
      </group>
      {/* stack of finished prints */}
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} position={[-2.05, 0.012 + i * 0.012, 0.6]} rotation={[-Math.PI / 2, 0, 0.08 * (i % 2 ? 1 : -1)]} receiveShadow castShadow>
          <planeGeometry args={[1.05, 1.48]} />
          <meshStandardMaterial color="#fdfdfb" roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* floor shadow catcher */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[12, 12]} />
        <shadowMaterial opacity={0.12} />
      </mesh>
    </group>
  );
}

export default function PrinterScene() {
  const progress = useRef(0);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Read scroll position only; never intercept or alter scrolling.
    const onScroll = () => {
      const el = host.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const span = r.height + window.innerHeight * 0.3;
      progress.current = Math.min(1, Math.max(0, (window.innerHeight * 0.55 - r.top) / span + 0.25));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div ref={host} style={{ width: "100%", height: "100%" }}>
      <Canvas shadows dpr={[1, 1.75]} camera={{ position: [0, 2.6, 5.4], fov: 40 }} gl={{ antialias: true, powerPreference: "low-power" }} aria-hidden="true">
        <ambientLight intensity={0.75} />
        <directionalLight position={[3, 6, 4]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-4, 2, -2]} intensity={0.35} color="#cfe8dc" />
        <Printer progress={progress} />
      </Canvas>
    </div>
  );
}
