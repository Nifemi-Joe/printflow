"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

const EMERALD = "#0a7a55";
const EMERALD_DEEP = "#05402d";
const GRAPHITE = "#3b4349";
const INK = "#000906";

/**
 * One continuous world, read left to right: the student's phone, the shop's
 * printer, the collection counter. Scrolling walks the camera along it, and a
 * single sheet of paper travels the same way — so the motion is the explanation
 * of the product, not decoration on top of it.
 */

// ----------------------------------------------------------------- textures

const DISPLAY = "'Bricolage Grotesque Variable', 'Bricolage Grotesque', sans-serif";
const BODY = "'Atkinson Hyperlegible', system-ui, sans-serif";

function drawPhone(g: CanvasRenderingContext2D) {
    const { width: w, height: h } = g.canvas;
    g.fillStyle = "#f5f7f4";
    g.fillRect(0, 0, w, h);
    g.fillStyle = EMERALD_DEEP;
    g.fillRect(0, 0, w, 86);
    g.fillStyle = "#ffffff";
    g.font = `700 30px ${DISPLAY}`;
    g.fillText("PrintFlow", 30, 56);

    g.fillStyle = "#ffffff";
    g.fillRect(24, 118, w - 48, 232);
    g.strokeStyle = "#d6dbd5";
    g.lineWidth = 2;
    g.strokeRect(24, 118, w - 48, 232);
    g.fillStyle = EMERALD_DEEP;
    g.font = `700 32px ${DISPLAY}`;
    g.fillText("CSC 201 notes", 48, 172);
    g.fillStyle = "#5a6168";
    g.font = `22px ${BODY}`;
    g.fillText("24 pages · A4 · black & white", 48, 212);
    g.fillText("Double-sided, 1 copy", 48, 248);
    g.fillStyle = "#e4f2ec";
    g.fillRect(48, 272, 190, 46);
    g.fillStyle = EMERALD_DEEP;
    g.font = `700 22px ${BODY}`;
    g.fillText("Ready to print", 64, 303);

    g.fillStyle = EMERALD;
    g.fillRect(24, 382, w - 48, 74);
    g.fillStyle = "#ffffff";
    g.font = `700 28px ${DISPLAY}`;
    g.fillText("Get exact price", 92, 428);
}

function drawTicket(g: CanvasRenderingContext2D) {
    const { width: w } = g.canvas;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, g.canvas.height);
    g.fillStyle = EMERALD_DEEP;
    g.font = `700 40px ${DISPLAY}`;
    g.fillText("CSC 201 notes", 44, 92);
    g.fillStyle = "#5a6168";
    g.font = `26px ${BODY}`;
    g.fillText("24 pages, A4, black & white", 44, 140);
    g.fillText("Double-sided, 1 copy", 44, 176);

    g.strokeStyle = "#d6dbd5";
    g.setLineDash([8, 8]);
    g.lineWidth = 2;
    for (const y of [220, 300, 380]) {
        g.beginPath();
        g.moveTo(44, y);
        g.lineTo(w - 44, y);
        g.stroke();
    }
    g.setLineDash([]);

    g.fillStyle = "#24292e";
    g.font = `26px ${BODY}`;
    g.fillText("12 sheets", 44, 268);
    g.fillText("₦420.00", 352, 268);
    g.fillText("Service fee", 44, 348);
    g.fillText("₦56.30", 368, 348);
    g.fillStyle = EMERALD_DEEP;
    g.font = `700 38px ${DISPLAY}`;
    g.fillText("Total", 44, 446);
    g.fillText("₦476.30", 312, 446);

    g.fillStyle = EMERALD;
    g.fillRect(44, 540, w - 88, 96);
    g.fillStyle = "#ffffff";
    g.font = `700 34px ${DISPLAY}`;
    g.fillText("Pickup  482 913", 92, 600);
}

function drawCode(g: CanvasRenderingContext2D) {
    const { width: w, height: h } = g.canvas;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#d6dbd5";
    g.lineWidth = 3;
    g.strokeRect(2, 2, w - 4, h - 4);
    g.fillStyle = "#5a6168";
    g.font = `24px ${BODY}`;
    g.fillText("Show this at the counter", 36, 66);
    g.fillStyle = EMERALD_DEEP;
    g.font = `700 76px ${DISPLAY}`;
    g.fillText("482 913", 36, 150);
    g.fillStyle = EMERALD;
    g.fillRect(36, 178, 200, 8);
}

/**
 * A texture drawn on a 2D canvas. The brand faces may still be loading when the
 * scene mounts, so it redraws itself once they are ready rather than baking in
 * whatever fallback face the browser had at that moment.
 */
function useCanvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D) => void) {
    const drawRef = useRef(draw);
    drawRef.current = draw;

    const texture = useMemo(() => {
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        drawRef.current(c.getContext("2d")!);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return t;
    }, [width, height]);

    useEffect(() => {
        let live = true;
        void document.fonts?.ready
            .then(() => {
                if (!live) return;
                const c = texture.image as HTMLCanvasElement;
                drawRef.current(c.getContext("2d")!);
                texture.needsUpdate = true;
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [texture]);

    useEffect(() => () => texture.dispose(), [texture]);
    return texture;
}

// -------------------------------------------------------------------- paths

/**
 * The sheet's route, with one point per stage: on the phone, lifting away,
 * turned to be read, emerging from the printer, waiting on the counter.
 * Centripetal keeps a long hop from bulging the curve out of the scene.
 */
const SHEET_PATH = new THREE.CatmullRomCurve3(
    [
        new THREE.Vector3(-4.2, 0.22, 0.02),
        new THREE.Vector3(-2.3, 1.05, 0.25),
        new THREE.Vector3(-1.0, 1.15, 0.35),
        // Just clear of the output slot, which the printer's own rotation puts here.
        new THREE.Vector3(-0.15, 0.5, 1.18),
        new THREE.Vector3(4.35, 0.46, 0.35),
    ],
    false,
    "centripetal",
    0.5,
);

/**
 * Where the camera sits *relative to the sheet*. Tracking the subject rather
 * than flying an independent path is what keeps it framed at every stage: the
 * phone, the printer and the counter slide through the background behind it,
 * which is what gives the sense of travelling the length of the story.
 */
const CAMERA_OFFSET = new THREE.CatmullRomCurve3(
    [
        new THREE.Vector3(0.1, 0.85, 1.95),
        new THREE.Vector3(0.55, 0.7, 2.9),
        new THREE.Vector3(0.3, 0.4, 2.9),
        new THREE.Vector3(1.15, 1.0, 3.3),
        new THREE.Vector3(0.75, 1.35, 4.0),
    ],
    false,
    "catmullrom",
    0.4,
);

/** Lerps across evenly spaced keyframes, so a number can follow the same t as a curve. */
function sampleKeys(keys: readonly number[], t: number): number {
    const clamped = Math.min(1, Math.max(0, t)) * (keys.length - 1);
    const i = Math.min(keys.length - 2, Math.floor(clamped));
    const f = clamped - i;
    return keys[i]! + (keys[i + 1]! - keys[i]!) * f;
}

// Flat on the phone, turning upright to be read, drooping as it feeds out of the
// printer, flat again on the counter.
const SHEET_PITCH = [-1.38, -1.0, -0.3, -1.22, -Math.PI / 2];
const SHEET_YAW = [0.2, 0.12, 0, 0, -0.15];
// It starts as the document on a phone screen and grows into a real sheet of paper.
const SHEET_SCALE = [0.32, 0.8, 1, 1, 1];

// ------------------------------------------------------------------- pieces

function Phone({ screen }: { screen: THREE.Texture }) {
    return (
        <group position={[-4.2, 0, 0]} rotation={[0, 0.2, 0]}>
            <mesh position={[0, 0.03, 0]} castShadow receiveShadow>
                <boxGeometry args={[0.64, 0.06, 1.3]} />
                <meshStandardMaterial color={INK} roughness={0.35} metalness={0.3} />
            </mesh>
            <mesh position={[0, 0.062, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.58, 1.2]} />
                <meshBasicMaterial map={screen} toneMapped={false} />
            </mesh>
        </group>
    );
}

function Printer({ led }: { led: MutableRefObject<THREE.MeshStandardMaterial | null> }) {
    return (
        <group position={[0, 0, 0]} rotation={[0, -0.22, 0]}>
            <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
                <boxGeometry args={[2.4, 0.6, 1.7]} />
                <meshStandardMaterial color={GRAPHITE} roughness={0.55} metalness={0.15} />
            </mesh>
            <mesh position={[0, 0.64, -0.2]} castShadow>
                <boxGeometry args={[2.3, 0.08, 1.2]} />
                <meshStandardMaterial color="#4b555c" roughness={0.4} />
            </mesh>
            {/* output slot */}
            <mesh position={[0, 0.5, 0.852]}>
                <boxGeometry args={[1.45, 0.06, 0.01]} />
                <meshStandardMaterial color="#14181b" roughness={0.9} />
            </mesh>
            {/* control strip, with the status light that says the shop has power */}
            <mesh position={[0.85, 0.62, 0.55]}>
                <boxGeometry args={[0.5, 0.06, 0.3]} />
                <meshStandardMaterial color="#1d2226" />
            </mesh>
            <mesh position={[0.95, 0.66, 0.58]}>
                <sphereGeometry args={[0.035, 16, 16]} />
                <meshStandardMaterial ref={led} color={EMERALD} emissive={EMERALD} emissiveIntensity={1} />
            </mesh>
        </group>
    );
}

function Counter({ code }: { code: THREE.Texture }) {
    return (
        <group position={[4.2, 0, 0]} rotation={[0, -0.3, 0]}>
            <mesh position={[0, 0.21, 0]} castShadow receiveShadow>
                <boxGeometry args={[1.6, 0.42, 1.15]} />
                <meshStandardMaterial color="#ccd3cd" roughness={0.85} />
            </mesh>
            {/* collected prints, waiting under the code that releases them */}
            {[0, 1, 2, 3, 4, 5].map((i) => (
                <mesh key={i} position={[-0.26, 0.426 + i * 0.012, 0.06]} rotation={[-Math.PI / 2, 0, 0.05 * (i % 2 ? 1 : -1)]} castShadow receiveShadow>
                    <planeGeometry args={[0.78, 1.1]} />
                    <meshStandardMaterial color="#fdfdfb" roughness={0.9} side={THREE.DoubleSide} />
                </mesh>
            ))}
            <mesh position={[0.46, 0.6, 0.3]} rotation={[-0.22, -0.3, 0.03]} castShadow>
                <planeGeometry args={[0.78, 0.46]} />
                <meshStandardMaterial map={code} side={THREE.DoubleSide} roughness={0.85} />
            </mesh>
        </group>
    );
}

function World({ progress }: { progress: MutableRefObject<number> }) {
    const sheet = useRef<THREE.Group>(null);
    const led = useRef<THREE.MeshStandardMaterial | null>(null);
    const eased = useRef(0);

    const screen = useCanvasTexture(512, 1024, drawPhone);
    const ticket = useCanvasTexture(512, 724, drawTicket);
    const code = useCanvasTexture(512, 300, drawCode);

    // In demand mode nothing renders until something asks for it, so scrolling is
    // what wakes the scene up. The listener lives in here, inside the lazily
    // loaded chunk, so the page that never shows 3D never pays for it.
    const invalidate = useThree((s) => s.invalidate);
    useEffect(() => {
        invalidate();
        const onScroll = () => invalidate();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll, { passive: true });
        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
        };
    }, [invalidate]);

    // Reused so the per-frame work allocates nothing.
    const camAt = useMemo(() => new THREE.Vector3(), []);
    const lookAt = useMemo(() => new THREE.Vector3(), []);
    const sheetAt = useMemo(() => new THREE.Vector3(), []);

    useFrame((state, delta) => {
        // Damped follow: scrolling sets a target, the scene catches up to it, so a
        // flick of the wheel never turns into a jolt.
        //
        // The exponential form is what makes this feel the same everywhere. A plain
        // `delta * k` lerp is frame-rate dependent: on a 120 Hz laptop delta halves,
        // so the scene chases at half the rate and reads as laggy, while on a slow
        // phone it snaps. This settles at the same speed in wall-clock time whatever
        // the display is doing.
        const gap = progress.current - eased.current;
        eased.current += gap * (1 - Math.exp(-7 * delta));
        const p = Math.min(1, Math.max(0, eased.current));

        // On demand: keep asking for frames only while there is still motion left.
        // When the reader stops scrolling the scene stops rendering entirely, which
        // is most of what it costs a mid-range phone to have this on the page.
        if (Math.abs(gap) > 0.0002) state.invalidate();

        SHEET_PATH.getPoint(p, sheetAt);
        CAMERA_OFFSET.getPoint(p, camAt);
        lookAt.copy(sheetAt);
        state.camera.position.copy(sheetAt).add(camAt);
        state.camera.lookAt(lookAt);

        if (sheet.current) {
            sheet.current.position.copy(sheetAt);
            sheet.current.rotation.x = sampleKeys(SHEET_PITCH, p);
            sheet.current.rotation.y = sampleKeys(SHEET_YAW, p);
            const s = sampleKeys(SHEET_SCALE, p);
            sheet.current.scale.setScalar(s);
            // A zero-scale mesh still draws a speck; the document has not left the
            // phone yet, so there should be nothing there at all.
            sheet.current.visible = s > 0.02;
        }
        // The light breathes only while the printer is the subject.
        if (led.current) {
            const near = 1 - Math.min(1, Math.abs(p - 0.62) * 4);
            led.current.emissiveIntensity = 0.35 + near * (0.5 + Math.sin(state.clock.elapsedTime * 3) * 0.4);
        }
    });

    return (
        <>
            {/* Lit like paper on a desk by a window: one soft key, a cool fill from the
          viewer's side so nothing reads as a black slab, and a floor that takes
          the shadow. The bias keeps the sheet from shadowing itself when it lies
          almost flat against the phone. */}
            <ambientLight intensity={0.95} />
            <directionalLight
                position={[4, 7, 6]}
                intensity={1.25}
                castShadow
                shadow-mapSize={[512, 512]}
                shadow-bias={-0.0008}
                shadow-camera-left={-8}
                shadow-camera-right={8}
                shadow-camera-top={8}
                shadow-camera-bottom={-8}
            />
            <directionalLight position={[-3, 2.5, 6]} intensity={0.7} color="#dff0e8" />

            <Phone screen={screen} />
            <Printer led={led} />
            <Counter code={code} />

            <group ref={sheet}>
                <mesh castShadow>
                    <planeGeometry args={[1.2, 1.7]} />
                    <meshStandardMaterial map={ticket} side={THREE.DoubleSide} roughness={0.85} />
                </mesh>
            </group>

            {/* Catches the shadows; the page's own background shows through everywhere else. */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                <planeGeometry args={[40, 40]} />
                <shadowMaterial opacity={0.16} />
            </mesh>
        </>
    );
}

export default function JourneyScene({ progress, active }: { progress: MutableRefObject<number>; active: boolean }) {
    return (
        <Canvas
            shadows
            // `flat` turns off filmic tone mapping: this is white paper on a pale page,
            // and film curves make clean white read as dishwater grey.
            flat
            dpr={[1, 1.4]}
            camera={{ position: [-4.1, 1.07, 1.97], fov: 42 }}
            gl={{ antialias: true, powerPreference: "low-power" }}
            // Nothing is drawn while the stage is off screen, and nothing is drawn
            // while it is still: on a mid-range phone that is the difference between a
            // warm battery and a flat one.
            frameloop={active ? "demand" : "never"}
            aria-hidden="true"
        >
            <World progress={progress} />
        </Canvas>
    );
}