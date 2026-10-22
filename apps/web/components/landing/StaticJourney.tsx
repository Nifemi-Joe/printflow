/**
 * The same story the 3D stage tells, drawn flat: a document leaves a phone, a
 * printer prints it, and it waits at a counter behind a one-time code. Shown
 * first on every visit, and kept for good when 3D would be the wrong thing to
 * send someone — reduced motion, no WebGL, a saver-mode or low-memory device.
 */
export function StaticJourney() {
    return (
        <svg viewBox="0 0 420 580" role="img" aria-labelledby="journey-title" style={{ width: "100%", height: "100%" }} preserveAspectRatio="xMidYMid meet">
            <title id="journey-title">
                A document on a phone travels to a print shop and waits at the collection counter behind a one-time pickup code
            </title>

            {/* the route the document takes */}
            <path d="M118 150 C 210 176, 196 206, 268 236" fill="none" stroke="#0a7a55" strokeWidth="2" strokeDasharray="5 6" opacity="0.5" />
            <path d="M268 420 C 196 448, 206 452, 128 470" fill="none" stroke="#0a7a55" strokeWidth="2" strokeDasharray="5 6" opacity="0.5" />

            {/* 1. on the phone */}
            <g>
                <rect x="34" y="24" width="112" height="196" rx="14" fill="#000906" />
                <rect x="42" y="32" width="96" height="180" rx="9" fill="#f5f7f4" />
                <rect x="42" y="32" width="96" height="26" rx="9" fill="#05402d" />
                <text x="52" y="50" fontFamily="var(--font-display)" fontWeight="700" fontSize="11" fill="#fff">
                    PrintFlow
                </text>
                <rect x="50" y="68" width="80" height="62" rx="2" fill="#fff" stroke="#d6dbd5" />
                <text x="58" y="88" fontFamily="var(--font-display)" fontWeight="700" fontSize="10" fill="#05402d">
                    CSC 201 notes
                </text>
                <text x="58" y="104" fontFamily="var(--font-body)" fontSize="7.5" fill="#5a6168">
                    24 pages · A4 · B&amp;W
                </text>
                <rect x="58" y="112" width="44" height="12" rx="2" fill="#e4f2ec" />
                <text x="63" y="121" fontFamily="var(--font-body)" fontWeight="700" fontSize="7" fill="#05402d">
                    Ready to print
                </text>
                <rect x="50" y="142" width="80" height="22" rx="3" fill="#0a7a55" />
                <text x="90" y="157" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="9" fill="#fff">
                    Get exact price
                </text>
            </g>

            {/* 2. through the printer */}
            <g>
                <ellipse cx="300" cy="372" rx="104" ry="13" fill="#05402d" opacity="0.08" />
                <rect x="212" y="300" width="176" height="64" rx="9" fill="#2b3137" />
                <rect x="222" y="288" width="156" height="18" rx="5" fill="#3a4148" />
                <rect x="244" y="316" width="112" height="7" rx="3" fill="#14181b" />
                <circle cx="368" cy="330" r="4.5" fill="#0a7a55" />
                <g transform="translate(252 196) rotate(-3)">
                    <rect width="96" height="136" rx="2" fill="#fff" stroke="#d6dbd5" />
                    <text x="12" y="24" fontFamily="var(--font-display)" fontWeight="700" fontSize="11" fill="#05402d">
                        CSC 201 notes
                    </text>
                    <text x="12" y="40" fontFamily="var(--font-body)" fontSize="7.5" fill="#5a6168">
                        24 pages, A4, B&amp;W
                    </text>
                    <line x1="12" x2="84" y1="52" y2="52" stroke="#d6dbd5" strokeDasharray="3 3" />
                    <text x="12" y="68" fontFamily="var(--font-body)" fontSize="7.5" fill="#24292e">
                        12 sheets
                    </text>
                    <text x="84" y="68" textAnchor="end" fontFamily="var(--font-body)" fontSize="7.5" fill="#24292e">
                        ₦420.00
                    </text>
                    <text x="12" y="84" fontFamily="var(--font-body)" fontSize="7.5" fill="#24292e">
                        Service fee
                    </text>
                    <text x="84" y="84" textAnchor="end" fontFamily="var(--font-body)" fontSize="7.5" fill="#24292e">
                        ₦56.30
                    </text>
                    <text x="12" y="106" fontFamily="var(--font-display)" fontWeight="700" fontSize="10" fill="#05402d">
                        Total
                    </text>
                    <text x="84" y="106" textAnchor="end" fontFamily="var(--font-display)" fontWeight="700" fontSize="10" fill="#05402d">
                        ₦476.30
                    </text>
                    <rect x="12" y="114" width="72" height="14" rx="2" fill="#0a7a55" />
                    <text x="48" y="124" textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="7.5" fill="#fff">
                        Pickup 482 913
                    </text>
                </g>
            </g>

            {/* 3. waiting at the counter */}
            <g>
                <rect x="30" y="486" width="150" height="40" rx="5" fill="#e7eae6" />
                {[0, 1, 2, 3].map((i) => (
                    <rect key={i} x={46 + i} y={470 - i * 4} width="70" height="26" rx="2" fill="#fdfdfb" stroke="#d6dbd5" transform={`rotate(${i % 2 ? 1.5 : -1.5} 81 483)`} />
                ))}
                <g transform="translate(206 452)">
                    <rect width="140" height="78" rx="3" fill="#fff" stroke="#d6dbd5" />
                    <text x="16" y="26" fontFamily="var(--font-body)" fontSize="8.5" fill="#5a6168">
                        Show this at the counter
                    </text>
                    <text x="16" y="56" fontFamily="var(--font-display)" fontWeight="700" fontSize="26" fill="#05402d">
                        482 913
                    </text>
                    <rect x="16" y="64" width="54" height="4" fill="#0a7a55" />
                </g>
            </g>
        </svg>
    );
}