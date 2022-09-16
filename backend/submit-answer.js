const micro = require('micro')
const cors = require('micro-cors')()

const {fetchMatch, submitAnswer} = require('./modules/sanityApi')

const {json, send} = micro

const parse = async req => {
  const postBody = await json(req)
  return postBody
}

const handler = async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 200, {status: 'ok'})
  }

  if (req.method !== 'POST') {
    return send(res, 404, {error: 'please use post method'})
  }

  const postBody = req.body ? req.body : await parse(req)
  const {playerId, matchSlug, questionKey, selectedChoiceKey} = postBody

  if (!playerId) {
    return send(res, 400, {error: 'missing playerId'})
  }
  if (!matchSlug) {
    return send(res, 400, {error: 'missing matchSlug'})
  }
  if (!questionKey) {
    return send(res, 400, {error: 'missing questionKey'})
  }
  if (!selectedChoiceKey) {
    return send(res, 400, {error: 'missing selectedChoiceKey'})
  }

  const match = await fetchMatch(matchSlug)
  if (!match) {
    return send(res, 400, {error: `no match for slug ${matchSlug}`})
  }

  await submitAnswer(match, playerId, questionKey, selectedChoiceKey)
  return send(res, 200, {status: 'ok'})
}

module.exports = cors(handler)
