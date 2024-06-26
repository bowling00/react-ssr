import { ReactNode } from 'react'
import Koa, { Context } from 'koa'
import { Writable } from 'stream'
import path from 'path'
import serve from 'koa-static'
import mount from 'koa-mount'
import { getStartTemplate, getEndTemplate } from './getTemplate'

import { renderToPipeableStream } from 'react-dom/server'
import fs from 'fs'
import logger from 'koa-logger'
import renderHTML from './renderHTML'

const isDEV = process.env.NODE_ENV === 'development'
// compilation-stats.json 为webpack打包信息产物
const statsData = isDEV
  ? {}
  : JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), './compilation-stats.json'),
        'utf-8'
      )
    )

const publicPath = statsData.publicPath || ''
const assetsJS: { [x: string]: string }[] = isDEV
  ? [{ 'main.js': '/public/main.js' }]
  : statsData.assets
      .map((asset: { name: string; chunkNames: string[] }) => {
        if (asset.name.endsWith('.js') && asset.chunkNames.includes('main'))
          return { 'main.js': `${publicPath}${asset.name}` }
        else if (asset.name.endsWith('.js'))
          return { [asset.name]: `${publicPath}${asset.name}` }
        else return null
      })
      .filter((p: any) => !!p)

const assetsCSS = isDEV
  ? [{ 'main.css': '/public/main.css' }]
  : statsData.assets
      .map((asset: { name: string; chunkNames: string[] }) => {
        if (asset.name.endsWith('.css') && asset.chunkNames.includes('main'))
          return { 'main.css': `${publicPath}${asset.name}` }
        else if (asset.name.endsWith('.css'))
          return { [asset.name]: `${publicPath}${asset.name}` }
        else return null
      })
      .filter((p: any) => !!p)

const app = new Koa()

app.use(async (ctx, next) => {
  // mock 数据
  if (ctx.path === '/api/userData') {
    ctx.body = {
      id: 1,
      name: "dvlin",
      email: "root@dvlin.com",
    };
  } else {
    await next();
  }
});

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    ctx.status = (err as any)?.status || 500
    ctx.body = 'server error'
    ctx.app.emit('error', err, ctx)
  }
})

app.use(logger())

app.use(mount('/public', serve('./public-client')))

const response = (
  ctx: Context,
  markup: ReactNode,
  staticContext: { NOT_FOUND: boolean },
  helmetContext: any,
  state: any,
  dehydratedState: any
) => {
  return new Promise((resolve, reject) => {
    let didError = false
    const mainJs =
      assetsJS.find((ass) => Object.keys(ass).includes('main.js'))?.[
        'main.js'
      ] ?? ''

    const stream = new Writable({
      write(chunk, _encoding, cb) {
        ctx.res.write(chunk, cb)
      },
      final() {
        ctx.res.end(getEndTemplate({ state, dehydratedState }))
        resolve('ctx.resolve')
      },
    })
    // 将 html 分三段进行传输，分别为 startTemplate、 markup(react代码) 、endTemplate
    const { pipe } = renderToPipeableStream(markup, {
      bootstrapScripts: [mainJs],
      onShellReady() {
        // The content above all Suspense boundaries is ready.
        // If something errored before we started streaming, we set the error code appropriately.
        ctx.res.setHeader('Content-type', 'text/html')
        ctx.status = didError ? 500 : 200
        if (staticContext.NOT_FOUND) {
          ctx.status = 404
        }

        ctx.res.write(getStartTemplate({ assetsJS, assetsCSS, helmetContext }))

        pipe(stream)
      },
      onShellError() {
        // Something errored before we could complete the shell so we emit an alternative shell.
        ctx.status = 500
        ctx.res.end('server error')
      },
      onError(err) {
        didError = true
        reject(err)
      },
    })
  })
}

app.use(async (ctx) => {
  if (ctx.accepts(ctx.header.accept?.split(',') ?? []) === 'text/html') {
    const staticContext: { NOT_FOUND: boolean } = { NOT_FOUND: false }
    const { markup, queryClient, helmetContext, state, dehydratedState } =
      await renderHTML(ctx, staticContext)

    if (markup) {
      await response(
        ctx,
        markup,
        staticContext,
        helmetContext,
        state,
        dehydratedState
      )
      queryClient.clear()
    }
  }
})

app.on('error', (err) => {
  console.error('server error', err)
})

const port = 5001

app.listen(port, () => {
  console.log(`ssr server is listening on ${port}`)
})
