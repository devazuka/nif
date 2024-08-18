import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'

export const throttle = (fn, delay) => {
  const timeoutDelay = s => setTimeout(s, delay)
  const wait = async () => new Promise(timeoutDelay)
  const pendingCache = new Map()
  let lastExecution = wait()
  return (arg) => {
    const cached = pendingCache.get(arg)
    if (cached) return cached
    const result = lastExecution.then(() => fn(arg))
    lastExecution = result.then(wait, wait)
    lastExecution.finally(() => pendingCache.delete(arg)) // cleanup cache to not have a memory leak
    pendingCache.set(arg, result)
    return result
  }
}

const checked = {}
const ensureDir = async dir =>
  checked[dir] || (checked[dir] = fs.mkdir(dir, { recursive: true }).then(() => checked[dir] = true))

const headers = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.6',
  'sec-ch-ua': '"Not A(Brand";v="99", "Brave";v="121", "Chromium";v="121"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'sec-gpc': '1',
  'upgrade-insecure-requests': '1',
}
const raciusSearch = throttle(async nif => {
  const searchRes = await fetch(`https://www.racius.com/pesquisa/?q=${nif}`, {
    headers: { ...headers, referer: 'https://www.racius.com/' },
  })
  const searchContent = await searchRes.text()
  const link = searchContent
    .split('\n')
    .find(l => l.includes('results__col-link'))
  const pathname = link.split(/href="([^"]+)"/, 2)[1]
  const url = `https://www.racius.com/${pathname}`
  const res = await fetch(url, {
    headers: { ...headers, referer: 'https://www.racius.com/' },
  })
  const content = await res.text()
  const start = content.indexOf('<script type="application/ld+json">') + 35
  const end = content.indexOf('</script>', start)
  return { url, ...JSON.parse(content.slice(start, end)) }
}, 60000)

const portugalioSearch = throttle(async nif => {
  const res = await fetch(
    `https://www.portugalio.com/pesquisa/?q=${nif}&tipo=empresas`,
  )
  const content = await res.text()
  const script = content
    .split('\n')
    .find(l => l.includes('application/ld+json'))
  return JSON.parse(script.split(/">({.+})</g)[1])
}, 60000)

const EMPTY = { address: {} }
const orEmpty = (err) => (console.error(err.stack), EMPTY)

const europaSearch = async nif => {
  const altRes = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/PT/vat/${nif}?requesterMemberStateCode=PT&requesterNumber=516969250`)
  return altRes.json()
}

const parseEuropaAddress = addressStr => {
  const [streetAddress, addressLocality, postalCode] = addressStr?.split('\n') || []
  return { streetAddress, addressLocality, postalCode }
}

const notFoundErr = Error('Not found')
notFoundErr.body = Buffer.from('Nif Not found')
notFoundErr.status = 404
const getNifDataNoCache = async nif => {
  const [racius, portugalio, europa] = await Promise.all([
    raciusSearch(nif).catch(orEmpty),
    portugalioSearch(nif).catch(orEmpty),
    europaSearch(nif).catch(orEmpty),
  ])
  console.log('results for nif': nif)
  console.log('racius', racius)
  console.log('portugalio', portugalio)
  console.log('europa', europa)
  const name = racius.name || portugalio.name || europa.name
  if (!name) throw notFoundErr
  const radr = racius.address
  const padr = portugalio.address
  const eadr = parseEuropaAddress(europa.address)
  return {
    name,
    address: {
      postalCode: radr.postalCode || padr.postalCode || europa.postalCode,
      streetAddress: radr.streetAddress || padr.streetAddress || europa.streetAddress,
      addressCountry: radr.addressCountry || padr.addressCountry || 'PORTUGAL',
      addressLocality: radr.addressLocality || padr.addressLocality || europa.addressLocality,
    },
    description: portugalio.description || racius.description,
    portugalio: portugalio.url?.[0],
    racius: racius.url,
    legalName: racius.legalName || portugalio.legalName,
    taxID: racius.taxID || portugalio.taxID,
    vatID: racius.vatID || portugalio.vatID || europa.vatNumber,
  }

}

export const getNifData = async nif => {
  const dirPath = `nif/${nif.slice(0, 3)}/${nif.slice(3, 6)}`
  const path = `${dirPath}/${nif.slice(6)}.json`
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch {/* if fail to retrive from cache, just get it from the crawl */ }
  const result = await getNifDataNoCache(nif, dirPath)
  // save in cache to avoid repeating the query later
  await ensureDir(dirPath)
  await fs.writeFile(path, JSON.stringify(result), 'utf8')
  return result
}

// same as getNifData, but we return a buffer for the server
export const getNifResponse = async nif => {
  const dirPath = `nif/${nif.slice(0, 3)}/${nif.slice(3, 6)}`
  const path = `${dirPath}/${nif.slice(6)}.json`
  try { return await readFile(path) }
  catch {}
  const result = Buffer.from(JSON.stringify(await getNifDataNoCache(nif)))
  await ensureDir(dirPath)
  await fs.writeFile(path, result)
  return result
}

const isValidateNif = nif => {
  if (!/^(1|2|3|5|6|8|45|70|71|72|77|79|90|91|98)/.test(nif)) return false
  const checkSum = nif[0]*9+nif[1]*8+nif[2]*7+nif[3]*6+nif[4]*5+nif[5]*4+nif[6]*3+nif[7]*2
  const mod11 = checkSum - Math.trunc(checkSum / 11) * 11
  const comp = mod11 === 1 || mod11 === 0 ? 0 : 11 - mod11
  return Number(nif[8]) === comp
}

if (process.env.PORT) {
  const INVALID_NIF = Buffer.from('Invalid Nif')
  const CACHED_JSON = {
    'content-type': 'application/json; utf8',
    'cache-control': 'public, max-age=604800, immutable',
  }
  const srv = createServer(async ({ url }, response) => {
    const nif = url.slice(1, 12)
    console.log({ nif })
    if (!isValidateNif(nif)) {
      response.writeHead(400)
      response.end(INVALID_NIF)
      return
    }

    try {
      const body = await getNifResponse(nif)
      response.writeHead(200, CACHED_JSON)
      return response.end(body)
    } catch (err) {
      response.writeHead(err.status || 500)
      return response.end(err.body || err.message)
    }
  })

  await once(srv.listen(process.env.PORT), 'listening')
  console.log('server started, listenning on', process.env.PORT)
}

