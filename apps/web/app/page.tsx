import Link from "next/link";
import { Journey } from "@/components/landing/Journey";
import { ContactForm } from "@/components/landing/ContactForm";
import { PriceDemo } from "@/components/landing/PriceDemo";
import { Logo } from "@/components/ui";

/**
 * The four things that happen to a document, in order. They are the page's
 * argument, and they are also the four stages the scene moves through as the
 * reader scrolls past them.
 */
const STEPS = [
  {
    id: "how",
    n: "01",
    title: "It leaves your phone",
    body: "Add a PDF or Word file from wherever it already lives. We check it for malware, count the pages and show you a preview of exactly what will come out.",
  },
  {
    n: "02",
    title: "You see the price first",
    body: "Pick a shop, then pages, copies, colour, sides and binding. The total is built from your campus price list, line by line, and it is the amount you pay. Nothing is charged until you say so.",
  },
  {
    n: "03",
    title: "A shop prints it",
    body: "Your paid job joins the shop's queue with the exact spec and a print-ready file. You watch it move: accepted, printing, checked, ready.",
  },
  {
    n: "04",
    title: "You collect it with a code",
    body: "Six digits, generated when you want them, good for one handover. Nobody else can walk off with your prints, and nobody has to shout your name across a shop.",
  },
];

const FAQ = [
  {
    q: "Which files can I print?",
    a: "PDF and Word (.docx) files up to 50 MB and 2,000 pages. Every file is scanned for malware before a shop can open it, and Word files are converted to PDF so you can check exactly what will be printed.",
  },
  {
    q: "How is the price worked out?",
    a: "From your campus price list: the cost per sheet for the paper size, colour and sides you choose, plus any finishing such as binding, plus a service fee shown as its own line. The quote you see before paying is the amount you are charged.",
  },
  {
    q: "What if the shop cannot print my job?",
    a: "If the shop rejects the job or cannot finish it, you get a full refund automatically. You can cancel for a full refund any time before the shop accepts the job.",
  },
  {
    q: "How do I collect my prints?",
    a: "When your job is ready you get a notification. Open the order, generate your six-digit pickup code, and show it at the counter. Each code works once and expires after 72 hours.",
  },
  {
    q: "Who can see my documents?",
    a: "Only you, and staff at the shop you ordered from while they are working on your job. Download links last two minutes and every download is logged. Files are deleted after your university's retention period.",
  },
  {
    q: "Can my university set its own prices?",
    a: "Yes. A university either publishes one campus price list for all shops, or lets approved shops set their own prices within limits the university agrees. Either way, every change is a new dated version and is recorded in the audit log.",
  },
];

export default function Landing() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container">
          <Link href="/" className="brand" aria-label="PrintFlow home">
            <Logo /> PrintFlow
          </Link>
          <nav aria-label="Main">
            <a className="hide-sm" href="#how">
              How it works
            </a>
            <a className="hide-sm" href="#shops">
              For shops
            </a>
            <a className="hide-sm" href="#universities">
              For universities
            </a>
            <Link className="hide-sm" href="/contact">
              Contact
            </Link>
            <Link href="/login">Sign in</Link>
            <Link href="/register" className="btn btn-primary btn-small">
              Start printing
            </Link>
          </nav>
        </div>
      </header>

      <main id="main">
        <section className="container">
          <Journey
            steps={STEPS.length + 1}
            lead={
              <>
                <h1>Print your notes without the queue.</h1>
                <p className="lede">
                  Upload a PDF or Word file, see the exact price from your campus price list, pay online, and collect from the shop with a one-time code.
                </p>
                <div className="row" style={{ marginTop: "var(--space-6)" }}>
                  <Link href="/register" className="btn btn-primary">
                    Start printing
                  </Link>
                  <Link href="/shop/apply" className="btn btn-quiet">
                    Register a print shop
                  </Link>
                </div>
                <p className="journey-cue">Keep scrolling to follow one document from a phone to the counter.</p>
              </>
            }
          >
            {STEPS.map((s) => (
              <li className="journey-step" key={s.n} id={s.id}>
                <p className="journey-n" aria-hidden="true">
                  {s.n}
                </p>
                <h2>{s.title}</h2>
                <p>{s.body}</p>
              </li>
            ))}
          </Journey>
        </section>

        <section className="band" aria-labelledby="price-title">
          <div className="container">
            <h2 id="price-title">See what a job costs</h2>
            <p className="muted">Change the options to see how the price is built up, line by line.</p>
            <PriceDemo />
          </div>
        </section>

        <section className="band band-ink" id="shops" aria-labelledby="shops-title">
          <div className="container split">
            <div>
              <h2 id="shops-title">For print shops: a queue that runs itself</h2>
              <ul className="plain-list">
                <li>Paid jobs arrive in order with the exact spec, page count and a print-ready PDF.</li>
                <li>Accept, print, pause, report a fault and check quality from the counter or a phone.</li>
                <li>Hand over prints only against the student&apos;s one-time code. No more mix-ups.</li>
                <li>Give each staff member only the permissions they need, and see every action in the log.</li>
                <li>Daily reconciliation of payments, refunds and collected jobs.</li>
              </ul>
              <div className="row" style={{ marginTop: "1rem" }}>
                <Link href="/shop/apply" className="btn btn-primary">
                  Register your shop
                </Link>
                <Link href="/contact?as=shop" className="btn btn-quiet" style={{ color: "#fff", borderColor: "rgba(255,255,255,.4)" }}>
                  My university isn&apos;t on PrintFlow
                </Link>
              </div>
            </div>
            <div className="queue-board" aria-label="Example shop queue">
              <div className="q-row">
                <span>
                  <strong>PF-7KQ2M9XA</strong> 48 sheets, A4 B&amp;W, stapled
                </span>
                <span>Printing</span>
              </div>
              <div className="q-row">
                <span>
                  <strong>PF-H3N8V2LC</strong> 12 sheets, A4 colour
                </span>
                <span>Accepted</span>
              </div>
              <div className="q-row">
                <span>
                  <strong>PF-Q9D4T7RW</strong> 120 sheets, spiral bound
                </span>
                <span>Paid</span>
              </div>
              <div className="q-row">
                <span>
                  <strong>PF-B5Z1K8MN</strong> 6 sheets, A3 B&amp;W
                </span>
                <span>Ready</span>
              </div>
            </div>
          </div>
        </section>

        <section className="band" id="universities" aria-labelledby="uni-title">
          <div className="container split">
            <div>
              <h2 id="uni-title">For universities: fair prices you control</h2>
              <p>Approve which shops can trade on campus, publish the price list, and see every order, refund and dispute in one place.</p>
              <ul className="plain-list">
                <li>Choose university-set prices, or let approved shops set prices within limits you agree.</li>
                <li>Price lists are versioned with effective dates. A student&apos;s confirmed price never changes.</li>
                <li>Suspend a shop in one step. Resolve disputes with full or partial refunds.</li>
                <li>Set how long documents are kept, and handle data export and deletion requests.</li>
              </ul>
            </div>
            <div className="sheet" id="onboarding">
              <h3>Bring PrintFlow to your campus</h3>
              <p className="muted">We set up your campuses and price list with you, your team approves the first shops, then students can order.</p>
              <ContactForm />
            </div>
          </div>
        </section>

        <section className="band" aria-labelledby="pricing-title">
          <div className="container split">
            <div>
              <h2 id="pricing-title">What students pay</h2>
              <p>The printing price comes from the campus price list. PrintFlow adds a service fee that is shown as a separate line on every quote, before payment. There are no other charges.</p>
            </div>
            <div>
              <h2>What shops and universities pay</h2>
              <p>Shops receive the printing price of every job they complete. Terms for universities are agreed during onboarding; ask us using the form above.</p>
            </div>
          </div>
        </section>

        <section className="band" aria-labelledby="faq-title">
          <div className="container" style={{ maxWidth: 820 }}>
            <h2 id="faq-title">Questions</h2>
            {FAQ.map((f) => (
              <details className="faq" key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
            {/* A student reading the questions is the one person most likely to
                need a human, and the contact form is otherwise buried in a
                section written for universities. */}
            <p style={{ marginTop: "var(--space-5)" }}>
              Something gone wrong with an order, or a question not answered here?{" "}
              <Link href="/contact?as=student">Tell us about it</Link> and we&apos;ll reply.
            </p>
          </div>
        </section>

        <section className="band band-ink" aria-labelledby="cta-title">
          <div className="container">
            <h2 id="cta-title">Your next handout, printed before you get there.</h2>
            <div className="row">
              <Link href="/register" className="btn btn-primary" style={{ background: "#fff", color: "var(--emerald-deep)" }}>
                Create a student account
              </Link>
              <Link href="/login" className="btn btn-quiet" style={{ color: "#fff", borderColor: "rgba(255,255,255,.4)" }}>
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container row" style={{ justifyContent: "space-between" }}>
          <span>PrintFlow, campus printing for Nigerian universities.</span>
          <span className="row">
            <Link href="/contact">Contact us</Link>
            <Link href="/privacy">Privacy</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
