import Layout from '../components/Layout'
import Link from 'next/link'

export default function NotFound() {
  return (
    <Layout title="404 — Not Found">
      <div className="min-h-[60vh] flex items-center justify-center text-center px-4">
        <div>
          <p className="font-mono text-cloud-500 text-sm mb-3">404</p>
          <h1 className="font-display text-4xl font-bold text-ink-900 mb-3">Page not found</h1>
          <p className="text-ink-400 mb-8">This page has drifted into the void of the cloud.</p>
          <Link href="/" className="btn-primary">Back to home</Link>
        </div>
      </div>
    </Layout>
  )
}
