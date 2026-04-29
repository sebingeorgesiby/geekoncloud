import Head from 'next/head'
import Navbar from './Navbar'
import Footer from './Footer'

interface LayoutProps {
  children: React.ReactNode
  title?: string
  description?: string
  ogImage?: string
}

export default function Layout({ children, title, description, ogImage }: LayoutProps) {
  const siteTitle = title ? `${title} — GeekOnCloud` : 'GeekOnCloud — DevOps, Cloud & Infrastructure'
  const desc = description || 'Practical guides, deep dives and opinions on DevOps, Cloud, and Infrastructure engineering.'

  return (
    <>
      <Head>
        <title>{siteTitle}</title>
        <meta name="description" content={desc} />
        <meta property="og:title" content={siteTitle} />
        <meta property="og:description" content={desc} />
        {ogImage && <meta property="og:image" content={ogImage} />}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </div>
    </>
  )
}
