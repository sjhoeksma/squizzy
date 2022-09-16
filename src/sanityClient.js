const sanityClient = require('@sanity/client')
const {sanityClientConfig} = require('../sanityClientConfig')
if (sanityClientConfig.projectId === 'puj7p168') {
  console.error(
    'Please change the projectId in ./sanityClientConfig.js to match the projectId found in ./studio/sanity.json'
  )
}

if (!sanityClientConfig.apiHost)
  sanityClientConfig.apiHost =
    !window || window.location.hostname === 'localhost'
      ? 'http://localhost:3900'
      : window.location.protocol + '//' + window.location.host
export default sanityClient(sanityClientConfig)
