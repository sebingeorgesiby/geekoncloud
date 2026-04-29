import Head from 'next/head'
import PostEditor from '../../components/PostEditor'

export default function NewPost() {
  return (
    <>
      <Head><title>New Post — GeekOnCloud Admin</title></Head>
      <PostEditor />
    </>
  )
}
