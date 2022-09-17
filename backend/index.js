const express = require('express')
const ws = require('ws')
const cors = require('cors')
const bodyParser = require('body-parser')
const backend = require('./modules/sanity-io-backend')
const mergeDeep = require('./modules/deepMerge')
const swStats = require('swagger-stats')
const apiSpec = require('./swagger.json')
const apiSignUp = require('./sign-up-player')
const apiSubmitAnswer = require('./submit-answer')
const apiWithdrawPlayer = require('./withdraw-player')
const fs = require('fs')
const path = require('path')
const options = require('./modules/configOptions')
const setupWebSocket = require('./modules/setupWebSocket')
var app = express()

backend.options = mergeDeep(backend.options,options)
//Swagger Stats
if (options.stats.enabled) {
  var swStatOptions = {
    swaggerSpec: apiSpec,
    onAuthenticate: function(req, username, password) {
      // simple check for username and password
      return username === options.stats.user && password === options.stats.password
    },
    uriPath: '/stats',
    authentication: options.stats.authentication || false
  }
  app.use(swStats.getMiddleware(swStatOptions))
  app.get('/stats', function(req, res) {
    res.redirect(swStatOptions.authentication ? '/stats/ui' : '/stats/ux#/')
  })
}

//Configure proxy,bodyparser and cors
app.set('trust proxy', true) // trust first proxy
app.use(bodyParser.json({limit: options.web.limit || '50mb'}))
app.use(bodyParser.urlencoded({limit: options.web.limit || '50mb', extended: true}))
app.use(
  cors({
    origin: function(origin, callback) {
      return callback(null, true)
    },
    credentials: true
  })
)

//static file handler to Studio
app.use('/studio', express.static('studio'))
//static file handler to UserApp
app.use(express.static('app'))
app.use('/favicon.ico', express.static('app'))
app.engine('html', require('ejs').renderFile)
app.get('/match/:token', function(req, res) {
  res.render(__dirname + '/app/index.html')
})
app.get('/studio/*', function(req, res) {
  res.render(__dirname + '/studio/index.html')
})

app.use('/api/sign-up-player', apiSignUp)
app.use('/api/submit-answer', apiSubmitAnswer)
app.use('/api/withdraw-player', apiWithdrawPlayer)


//Add the sainty-io backend urls
backend.router(app, options)
if (options.greenlocks.enabled) {
  require('greenlock-express')
    .init({
      packageRoot: __dirname,

      // contact for security and critical bug notices
      configDir: './greenlocks',

      maintainerEmail: 'info@3pi.dev',

      // whether or not to run at cloudscale
      cluster: false
    })
    .ready(function(glx) {
      setupWebSocket(glx.httpsServer(), backend)
      //Add io monitoring if swagger is enabled
      if (options.stats.enabled) var io = require('socket.io').listen(glx.httpsServer())
    })
    .serve(app)
} else {
  //Start the server
  var server = app.listen(options.PORT || 3900, options.HOST || '0.0.0.0', function() {
    console.log('sanity-io-backend running on port.', server.address().port)
  })
  setupWebSocket(server, backend)
  //Add io monitoring if swagger is enabled
  if (options.stats.enabled) var io = require('socket.io').listen(server)
}

//Ensure we flush db before exiting
if (process.platform === 'win32') {
  var rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  })

  rl.on('SIGINT', function() {
    process.emit('SIGINT')
  })
}

process.on('SIGINT', function() {
  backend.flushDBs()
  console.log('DBs flushed before exiting')
  //graceful shutdown
  process.exit()
})
