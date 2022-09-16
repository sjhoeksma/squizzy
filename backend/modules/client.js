const sanityClient = require('@sanity/client')
const {sanityClientConfig} = require('../../sanityClientConfig')
const options = require('./configOptions')

sanityClientConfig.token = options.token
//API calls are internal for backend
sanityClientConfig.apiHost = options.greenlocks.enabled
  ? options.apiHost
    ? options.apiHost
    : 'https://squizzy.os1.nl'
  : 'http://localhost:' + (options.PORT || 3900)
const client = sanityClient(sanityClientConfig)

module.exports = client
