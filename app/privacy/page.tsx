import Link from "next/link";
import PublicNav from "@/components/PublicNav";

export const metadata = {
  title: "Privacy Policy — ZCORIQ",
  description: "ZCORIQ Privacy Policy.",
};

/**
 * /privacy — ZCORIQ Privacy Policy.
 *
 * This is a working starter template. Before launch:
 *   - Replace placeholder entity name with your registered legal entity.
 *   - Replace contact email with the real support / DPO address.
 *   - Validate against the Digital Personal Data Protection Act 2023 (India)
 *     and (if you take EU/UK customers) GDPR/UK GDPR.
 *   - For schools, India's NCPCR guidelines and any state-specific student-
 *     data rules should also be considered.
 *   - Have qualified legal counsel review before paying customers.
 */
export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white">
      <header className="border-b border-slate-200/60 bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">ZCORIQ</span>
          </Link>
          <PublicNav />
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-6 py-12 prose prose-slate">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-slate-500 mb-8">Last updated: 30 April 2026</p>

        <p>
          This Privacy Policy explains how ZCORIQ (&quot;we&quot;, &quot;us&quot;) collects,
          uses, and shares information about you when you use the ZCORIQ
          platform (the &quot;Service&quot;).
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">1. Information we collect</h2>
        <p><strong>Account information.</strong> Name, email address, password
          (stored as a salted hash by our authentication provider, Supabase),
          role (student / teacher / Admin Head), and the school you are
          associated with.</p>
        <p><strong>Content you upload.</strong> Notes, images, past papers,
          quizzes, student responses, and similar material you submit to the
          Service.</p>
        <p><strong>Usage data.</strong> Pages visited, features used,
          quiz attempts, scores, time spent, error logs, and approximate
          geographic location (derived from IP address). Used to operate and
          improve the Service.</p>
        <p><strong>Payment data.</strong> If you subscribe to a paid plan,
          Razorpay processes your payment. We do not see or store your card
          details. We retain limited transaction metadata (order ID, amount,
          timestamp) for invoicing and refund handling.</p>
        <p><strong>Cookies and similar.</strong> Authentication cookies/tokens
          to keep you signed in. We do not use third-party advertising trackers.</p>

        <h2 className="text-xl font-bold mt-8 mb-3">2. How we use information</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>To provide the Service — authenticate you, save your work, generate quizzes, score attempts, and produce reports.</li>
          <li>To send transactional emails — invites, password resets, receipts, account notifications.</li>
          <li>To improve the Service — debug issues, study aggregate usage patterns, and prioritise features. We do not sell personal data.</li>
          <li>To comply with legal obligations and to protect users and the Service from abuse.</li>
        </ul>

        <h2 className="text-xl font-bold mt-8 mb-3">3. Third-party processors</h2>
        <p>
          ZCORIQ relies on a small number of third-party service providers to
          deliver the Service. We share with them only what is necessary, under
          contractual data-protection obligations:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li><strong>Supabase</strong> — authentication, database, file storage, transactional email.</li>
          <li><strong>Google (Gemini API)</strong> and <strong>Groq</strong> — AI inference for question generation, X-ray analysis, and tutoring features. Content you submit for AI processing is sent to these providers per their API terms.</li>
          <li><strong>Razorpay</strong> — payment processing. Card details go directly to Razorpay; we never see them.</li>
          <li><strong>Hosting / infrastructure</strong> — the cloud provider on which ZCORIQ runs (currently Vercel; may change with notice).</li>
        </ul>

        <h2 className="text-xl font-bold mt-8 mb-3">4. Data retention</h2>
        <p>
          We retain account and content data for as long as your account is
          active. If you delete your account, we delete your personal data
          within 30 days, except where retention is required by law (e.g.
          tax invoices) or where data has been aggregated and anonymised so it
          can no longer be linked to you. School-managed accounts are deleted
          at the request of the school&apos;s Admin Head.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">5. Children&apos;s data</h2>
        <p>
          ZCORIQ is intended for use in educational settings, including by
          students under 18. School student accounts are created by a teacher
          or Admin Head on behalf of the school, and the school is responsible
          for obtaining any parental consent required by local law. Independent
          (non-school) student accounts must be created by a parent/guardian
          for users under 18. We do not knowingly collect personal data from
          children outside these contexts; if you believe we have, contact us
          and we will delete it.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">6. Your rights</h2>
        <p>Subject to applicable law, you may request to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Access the personal data we hold about you.</li>
          <li>Correct inaccurate data.</li>
          <li>Delete your account and associated data.</li>
          <li>Export your account data in a portable format.</li>
          <li>Object to or restrict certain processing.</li>
        </ul>
        <p>Email <a href="mailto:hello@bloomiq.app" className="text-emerald-700 font-semibold">hello@bloomiq.app</a> to exercise any of these rights.</p>

        <h2 className="text-xl font-bold mt-8 mb-3">7. Security</h2>
        <p>
          We use industry-standard measures to protect your data — encryption
          in transit (TLS), encryption at rest for databases via Supabase,
          row-level security policies to keep one user&apos;s data separate from
          another&apos;s, and limited internal access on a need-to-know basis.
          No system is perfectly secure; if we become aware of a breach
          affecting your data we will notify you without undue delay.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">8. International transfers</h2>
        <p>
          Some of our processors may store or process data outside India.
          Where this happens we rely on standard contractual clauses or other
          legally recognised transfer mechanisms.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">9. Changes to this policy</h2>
        <p>
          We may update this Policy from time to time. Material changes will
          be notified via email or in-product banner at least 14 days before
          they take effect.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">10. Contact</h2>
        <p>
          Questions about this Policy or our handling of your data? Email{" "}
          <a href="mailto:hello@bloomiq.app" className="text-emerald-700 font-semibold">hello@bloomiq.app</a>.
        </p>

        <p className="text-xs text-slate-500 italic mt-12 border-t border-slate-200 pt-6">
          Note: This Policy is a working draft. Before ZCORIQ&apos;s first paying
          customer, it should be reviewed by qualified counsel familiar with
          India&apos;s DPDP Act 2023 and any other jurisdictions you serve.
        </p>
      </article>

      <footer className="max-w-6xl mx-auto px-6 py-8 text-center text-sm text-slate-500 border-t border-slate-200">
        © ZCORIQ ·{" "}
        <Link href="/terms" className="hover:text-emerald-700">Terms</Link> ·{" "}
        <Link href="/privacy" className="hover:text-emerald-700">Privacy</Link>
      </footer>
    </main>
  );
}
