/*
sainty-io-Backend.js simulates the sainty.io backend. It is not intended for production.

To use it create an express-js web-application and include the module and add to router

const {backendRouter} = require('./module/sanity-io-backend.js')
backendRouter(app) //Where app is the web-express application

In your sainty.json for studio, please set api.apiHost to this service.

We load databases into memory, lock for update, write changes back to the files and
reload DB when externally changed.

TODO:
- For now we use one big file, implement split by _type, db is directory Each file is <id>.json.
- Image processing and cdn
- Authentication and Authorization
- Support installing plugins https://www.sanity.io/plugins/sanity-plugin-asset-source-unsplash
- https://github.com/percolate/jsonmatch , https://www.npmjs.com/package/@dextcloud/jsonmatch
*/
'use strict'
const {parse, evaluate} = require('groq-js')
const fs = require('fs')
const resolvePath = require('path').resolve
const AwaitLock = require('await-lock').default //Strange but returns object
const DiffMatchPatch = require('diff-match-patch')
const sharp = require('sharp')
const dmp = new DiffMatchPatch()
const url = require('url')
const session = require('express-session')
const FileStore = require('session-file-store')(session)
const grant = require('grant-express')
const fetch = require('node-fetch')
const jwt = require('jsonwebtoken')
const readline = require('readline')
const mergeDeep = require('./deepMerge.js')
const nanoid = require('nanoid')

//The real backend
var backend = {
  cache: [], //We cache databases in memory to keep speed
  clients: [], //List of active clients

  options: {
    apiVersion: 'v2021-06-07',
    url: 'http://localhost:3900',
    secret: 'sanity.io',
    //Config items
    max_cache: 6, //We default is to keep 6 db object in memory
    dbDir: './db/', //Location of the databases
    archiveEvents: ['createOrReplace', 'create', 'createIfNotExists', 'delete', 'patch']
  },

  //Verify the JWT Token
  verifyJWTToken: function(token) {
    //return Promise.resolve({data:{}})
    return new Promise((resolve, reject) => {
      if (token == backend.options.token) {
        resolve({data: {}})
      } else {
        jwt.verify(token, backend.options.secret, (err, decodedToken) => {
          if (err || !decodedToken) {
            return reject(err)
          }
          resolve(decodedToken)
        })
      }
    })
  },

  //Create the JWT Token
  createJWToken: function(data, expires = 3600) {
    let token = jwt.sign(
      {
        data: data || {}
      },
      backend.options.secret,
      {
        expiresIn: expires,
        algorithm: 'HS256'
      }
    )
    return token
  },

  verifyJWT: function(req, res, next) {
    let token
    if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
      token = req.headers.authorization.split(' ')[1]
    } else if (req.query && req.query.token) {
      token = req.query.token
    } else if (
      req.session &&
      req.session.grant &&
      req.session.grant.response &&
      req.session.grant.response.jwt
    ) {
      req.user = req.session.grant.response.jwt.id_token.payload
      next()
      return
    } else {
      token = req.method === 'POST' ? req.body.token : req.query.token || req.query.token
    }
    backend
      .verifyJWTToken(token)
      .then(decodedToken => {
        req.user = decodedToken.data
        next()
      })
      .catch(err => {
        res.status(401).json({message: 'Invalid auth token provided.'})
      })
  },

  //Set one of more config items
  setConfig: function(config) {
    for (const [key, el] of Object.entries(config)) {
      backend[key] = el
    }
  },

  //Get the dbName from the request. TODO: Implement from cookie
  dbNameFromReq: function(req) {
    //let dbName=req.headers.host.split("\\.", 2)[0] //TODO get from other setting
    return 'pv5f4dow-x'
  },

  //Get the userId from the request. TODO: Implement from cookie
  userIdFromReq: function(req) {
    return req.session && req.session.user ? req.session.user : 'pB5I15RfY-x'
  },

  //Create dataSet from Request pathName
  dataSetFromReq: function(req) {
    if (backend.namespace) return backend.namespace
    let str = req._parsedUrl ? req._parsedUrl.pathname : 'production'
    let baseArray = new String(str).split('/')
    let base = baseArray[baseArray.length - 1]
    if (base.lastIndexOf('.') != -1) {
      base = base.substring(0, base.lastIndexOf('.'))
    }
    if (base === 'drafts') base = baseArray[baseArray.length - 2]
    return base
  },

  //Find the database in cache
  findDb: function(name) {
    let found = -1
    for (let index = 0; index < backend.cache.length; index++) {
      if (backend.cache[index].name == name) {
        found = index
        break
      }
    }
    return found
  },

  //Get database from file or cache
  getDb: function(dbName, dataSet) {
    let fullName = dbName + '/' + dataSet
    let fileName = backend.options.dbDir + fullName + '.json'
    let found = backend.findDb(fullName)
    if (found >= 0) {
      //Move to first position if not on first position
      if (backend.cache[found].error) {
        backend.cache.splice(found, 1) //DB requires reload
        found = -1
      } else if (
        !fs.existsSync(fileName) ||
        (fs.existsSync(fileName) &&
          fs.statSync(fileName).mtime.toString() != backend.cache[found].mtime.toString())
      ) {
        console.log(`DB ${fullName} changed externally`)
        backend.cache.splice(found, 1) //DB has changed externally reload it
        found = -1
      }
      if (found > 0) {
        //Make sure found record is in first position
        let db = backend.cache[found]
        backend.cache.splice(found, 1)
        backend.cache.unshift(db)
      }
    }

    if (found == -1) {
      //Load DB and add to first position
      if (fs.existsSync(fileName)) {
        const stat = fs.statSync(fileName)
        backend.cache.unshift({
          name: fullName,
          json: JSON.parse(fs.readFileSync(fileName)),
          isDirty: false,
          mtime: stat.mtime,
          lock: new AwaitLock()
        })
      } else {
        backend.cache.unshift({
          name: fullName,
          json: [],
          isDirty: true,
          lock: new AwaitLock()
        })
        backend.saveDb(dbName, dataSet)
      }
    }
    if (backend.cache.length > backend.options.max_cache) backend.flushDBs()

    //Trim down the array if it is to large
    while (backend.cache.length > backend.options.max_cache) {
      backend.cache.pop()
    }
    //Return the db object
    return backend.cache[0]
  },

  flushDBs: function() {
    for (let i = 0; i < backend.cache.length; i++) {
      if (backend.cache[i].isDirty) {
        fs.mkdirSync(backend.options.dbDir + backend.cache[i].name, {recursive: true})
        let fileName = backend.options.dbDir + backend.cache[i].name + '.json'
        fs.writeFileSync(fileName, JSON.stringify(backend.cache[i].json))
        backend.cache[i].isDirty = false
        backend.cache[i].mtime = fs.statSync(fileName).mtime
      }
    }
  },

  //Save the database to file
  saveDb: function(dbName, dataSet) {
    if (!backend.options.writeDelay) {
      let fullName = dbName + '/' + dataSet
      let found = backend.findDb(fullName)
      if (found != -1 && backend.cache[found].isDirty) {
        fs.mkdirSync(backend.options.dbDir + fullName, {recursive: true})
        let fileName = backend.options.dbDir + fullName + '.json'
        fs.writeFileSync(fileName, JSON.stringify(backend.cache[found].json))
        backend.cache[found].isDirty = false
        backend.cache[found].mtime = fs.statSync(fileName).mtime
        //console.log("SavedDB:",fullName)
      }
    }
  },

  //Internal function to parse params from request
  _queryParams: function(req) {
    let params = {}
    for (const key in req.query) {
      if (req.query.hasOwnProperty(key) && key.charAt(0) == '$') {
        try {
          params[key.substr(1)] = JSON.parse(`[${req.query[key]}]`)[0]
        } catch (err) {
          console.log(err, key, req.query)
          params[key.substr(1)] = ''
        }
      }
    }
    return params
  },

  //Remove all comments from query string
  _queryString: function(req) {
    return new String(req.query.query)
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
      .replace(/\r?\n|\r|\t/g, '')
  },

  //Delete an object with given id
  _deleteById: function(id, dbName, dataSet) {
    let db = backend.getDb(dbName, dataSet)
    //If id is image delete it
    if (id.indexOf('image-') == 0) {
      let img = db.json.filter(el => el._id === id)[0]
      if (img && fs.existsSync(img.path)) fs.unlinkSync(img.path)
    }
    db.json = db.json.filter(el => el._id !== id)
    db.isDirty = true
  },

  //Create or replace an object
  _createOrReplace: function(rec, dbName, dataSet, transactionId) {
    let db = backend.getDb(dbName, dataSet)
    if (rec && rec._id) backend._deleteById(rec._id, dbName, dataSet)
    let result = Object.assign(
      {
        _createdAt: new Date().toISOString(),
        _id: nanoid(),
        _type: 'blank'
      },
      rec,
      {_updatedAt: new Date().toISOString(), _rev: transactionId} // _rev: nanoid() }
    )
    //Rule for Id
    if (result._id.charAt(result._id.length - 1) === '.') {
      result._id = result._id + nanoid()
    }
    db.json.push(result) //Push the created record
    db.isDirty = true
    return result
  },

  //dirty way to deep clone an object
  _deepClone: function(obj) {
    if (obj == null) return null
    return JSON.parse(JSON.stringify(obj))
  },

  //Create a transaction object
  _createTransaction: function(
    transactions,
    req,
    result,
    previous,
    transactionId,
    transaction,
    mutation
  ) {
    let visibility = req.query && req.query.visibility ? req.query.visibility : 'transaction'
    let ret = {
      // eventId: A unique id for this event, comprised of the transaction id and the document id
      eventId: transactionId + '#' + (result ? result._id : previous._id),
      // documentId: The document changed by these mutations
      documentId: result ? result._id : previous._id,
      // transactionId: The id of the transaction (one transaction may touch several documents,
      // so you may get several messages with the same transactionId)
      transactionId: transactionId,
      // transition: "update" means the document was updated, "appear" means the document just now started
      // matching your query. "disappear" means the document now left your scope. Appear/disappear may mean
      // the document is created/deleted, but it may also mean the properties of your document started/stopped
      // matching your query.
      transition: transaction,
      // identity: The identifier of the user submitting the changes
      identity: backend.userIdFromReq(req),
      // mutations: an array of mutations as they were submitted in a call to /data/mutate. There may be several,
      // but they will all be from the same transaction, and they will all pertain to the document specified in
      // documentId.
      mutations: [mutation],
      // result: if includeResult url-parameter was submitted, this will contain the entire document as it looks after
      // the mutations.
      result: result,
      // previous: if includePreviousRevision url-parameter was submitted, this will contain the document as it looked
      // before the mutations.
      previous: previous ? backend._deepClone(previous) : previous,
      // previousRev: The previous revision tag of the document before the changes (the current revision tag is always stored with
      // the document under the _rev key)
      previousRev: previous ? previous._rev : '',
      // resultRev: The revision tag after the changes. Due to the distributed nature of the Sanity backend, mutation events may
      // appear out of order, in a very correct client the mutations must be reassembled to an unbroken chain where previousRev
      // matches the resultRev of the previous mutation event.
      resultRev: transactionId,
      // timestamp: The timestamp of the transaction causing this change
      timestamp: new Date().toISOString(),
      // visibility: Whether the change that triggered this event is visible to queries (query) or only to
      // subsequent transactions (transaction). The listener client can specify a preferred visbility through
      // the visibility parameter.
      visibility: visibility
    }
    //See if there is already a transaction
    for (let index = 0; index < transactions.length; index++) {
      if (transactions[index].documentId === ret.documentId) {
        transactions[index].mutations.push(mutation)
        return transactions[index]
      }
    }
    transactions.push(ret)
    return ret
  },

  apiVersion: function() {
    return backend.options.apiVersion ? backend.options.apiVersion : 'v2021-06-07'
  },

  //Write the transaction to file
  _writeTransaction: async function(transactions, dbName, dataSet) {
    let fullName = dbName + '/' + dataSet
    let fileName = backend.options.dbDir + fullName + '.ndjson'
    transactions.forEach(change => {
      let data = {
        id: change.transactionId,
        timestamp: change.timestamp,
        revision: change.resultRev,
        author: change.identity,
        mutations: [],
        result: change.result,
        documentIDs: []
      }
      change.mutations.forEach(mut => {
        backend.options.archiveEvents.forEach(ev => {
          if (mut.hasOwnProperty(ev)) {
            data.mutations.push(mut)
            if (data.documentIDs.indexOf(change.documentId) < 0)
              data.documentIDs.push(change.documentId)
          }
        })
      })
      if (data.mutations.length != 0) {
        fs.writeFileSync(fileName, JSON.stringify(data), {flag: 'a'})
        fs.writeFileSync(fileName, '\n', {flag: 'a'})
      }
    })
  },

  // Iterate clients list and use write res object method to send
  // To Check if client is from dbName
  _sendChangesToAll: function(transactions, dbName, dataSet) {
    backend.clients.forEach(c => {
      if (c.dbName == dbName && c.dataSet == dataSet) {
        transactions.forEach(change => {
          evaluate(c.query, {
            dataset: [change.result || change.previous],
            params: c.params
          }).then(value => {
            value.get().then(data => {
              if (data) {
                //Create results based on the responses
                let event = Object.assign({}, change) //Create un deep clone
                if (!c.iResult || event.transition == 'disappear') delete event.result
                if (!c.iRevision) delete event.previous
                c.res.write(
                  `event: mutation\ndata: ${JSON.stringify(event)}\nid: ${event.eventId}\n\n`
                )
              }
            })
          })
        })
      }
    })
  },

  //Set a value using a groq statement. Because groq doesn't have set function we needed to rebuild part of logic
  //param: result set to parse
  //param: key the groq query key
  //param: value the value to insert
  //param: replace, should value be replaced (boolean), {replace:boolean,pos:array index increase} used when adding in array
  //param: setFunc, allows to have your own set function
  _setValue: function(result, key, value, replace, setFunc = null) {
    //Internal SetVal function
    function setVal(parent, index, data, mode) {
      // console.log("SV",parent[index]==undefined,parent,index,data,mode)
      index = isNaN(index)
        ? index
        : Number(index) + (typeof mode === 'object' && mode !== null ? mode.pos : 0)
      if (setFunc) data = setFunc(parent ? parent[index] : null, parent, index, data, mode)
      //If we have mode object, should we delete data
      if (typeof mode === 'object' && mode !== null && mode.replace && Array.isArray(data))
        parent.splice(index, data.length)

      if (mode || parent[index] == undefined) {
        //Should we replace or add
        if (data != null) {
          if (Array.isArray(parent) && Array.isArray(data)) {
            if (index < parent.length) parent.splice(index, 0, ...data)
            else parent.push(...data)
          } else parent[index] = data
        } else if (Array.isArray(parent)) parent.splice(index, 1)
        else delete parent[index]
      }
      return parent[index]
    }

    function parser(qstr, result, value, replace) {
      if (qstr.type == 'OpCall') {
        let found = result.filter(rec => {
          let l = parser(qstr.left, rec, null, false)
          let r = parser(qstr.right, rec, null, false)
          switch (qstr.op) {
            case '==':
              return l == r
            case '>=':
              return l >= r
            case '>':
              return l > r
            case '<=':
              return l <= r
            case '<':
              return l < r
            case '!=':
              return l != r
            default:
              console.log('Unknown Op:', q.op)
              return false
          }
        })
        return found
      } else if (qstr.type == 'Identifier') {
        return setVal(result, qstr.name, value, replace)
      } else if (qstr.type == 'Value') {
        return qstr.value
      } else if (qstr.type === 'Element') {
        if (qstr.hasOwnProperty('base')) result = parser(qstr.base, result, [], false)
        let idx = parser(qstr.index, result, 0, false)
        if (idx >= result.length) idx = result.length - 1
        if (idx < 0) idx = result.length + idx //idx=-
        if (idx < 0) idx = 0
        setVal(result, idx, value, replace)
        return result[idx]
      } else if (qstr.type === 'Attribute') {
        //Object
        if (qstr.hasOwnProperty('base')) result = parser(qstr.base, result, {}, false)
        if (Array.isArray(result)) {
          result.forEach(rec => {
            setVal(rec, qstr.name, value, replace)
          })
          return result //This can give errors if not processed correctly
        } else return setVal(result, qstr.name, value, replace)
      } else if (qstr.type === 'ObjectAttribute') {
        result[parser(qstr.key, result, null, false)] = parser(qstr.value, result, null, false)
        return result
      } else if (qstr.type === 'Object') {
        if (Array.isArray(result)) {
          result.forEach(rec => {
            qstr.attributes.forEach(attr => {
              parser(attr, rec, value, false)
            })
          })
        } else
          qstr.attributes.forEach(attr => {
            parser(attr, result, value, false)
          })
        return result
      } else if (qstr.type === 'Filter') {
        //Filter array of object
        if (qstr.hasOwnProperty('base')) result = parser(qstr.base, result, [], false)
        let rs = parser(qstr.query, result, value, replace)
        rs.forEach(rec => {
          setVal(result, result.indexOf(rec), value, replace)
        })
        //Reduce result of filter to 1, reduce complexity later
        return rs.length <= 1 ? rs[0] : rs
      } else {
        console.log(`SetValue type ${qstr.type} not supported`, JSON.stringify(qstr, null, 2))
      }
    }

    //console.log("QS:",key,JSON.stringify(parse(key),null,2),value,result,replace)
    parser(parse(key), result, value, replace)
    //console.log("QR:",JSON.stringify(result,null,2),key)
    return result
  },

  //Mutate a record
  mutate: async function(req, dbName, dataSet) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    if (!dataSet) dataSet = backend.dataSetFromReq(req)
    let db = backend.getDb(dbName, dataSet)
    let params = backend._queryParams(req) //Parameters for
    let transactionId = req.body.transactionId || nanoid() //Transaction if
    let transactions = [] //transctions
    let mutations = req.body.mutations //Get the array of muttations
    //console.log("Mutate",JSON.stringify(mutations,null,2))

    try {
      await db.lock.acquireAsync()
      if (mutations)
        for (const [mutType, mut] of Object.entries(mutations)) {
          //Add record to DB
          if (
            mut.hasOwnProperty('createOrReplace') ||
            mut.hasOwnProperty('create') ||
            mut.hasOwnProperty('createIfNotExists')
          ) {
            let rec = mut.createOrReplace || mut.create || mut.createIfNotExists
            let query = parse(`*[_type=="${rec._type}" && _id=="${rec._id}"][0]`) //We only will have one record
            let resultSet = await evaluate(query, {
              dataset: db.json,
              params: params
            })
            let data = await resultSet.get()
            if (!data || mut.hasOwnProperty('createOrReplace')) {
              let result = backend._createOrReplace(
                Object.assign(data || {}, rec),
                dbName,
                dataSet,
                transactionId
              )
              backend._createTransaction(
                transactions,
                req,
                result,
                data,
                transactionId,
                data ? 'update' : 'appear',
                mut
              )
            }
          }

          //Delete record(s) from DB
          else if (mut.hasOwnProperty('delete')) {
            let query
            if (mut.delete.hasOwnProperty('id')) query = parse(`*[_id=="${mut.delete.id}"]`)

            if (mut.delete.hasOwnProperty('query')) query = parse(mut.delete.query)

            let resultSet = await evaluate(query, {
              dataset: db.json,
              params: params
            })
            let results = await resultSet.get()
            if (!Array.isArray(results)) results = [results]
            for (const result of results) {
              backend._createTransaction(
                transactions,
                req,
                null,
                result,
                transactionId,
                'disappear',
                Object.assign(mut, {purge: true})
              )
              backend._deleteById(result._id, dbName, dataSet)
            }
          }

          //Patch a record
          else if (mut.hasOwnProperty('patch')) {
            const patch = mut.patch
            let query = parse(patch.id ? `*[_id=="${patch.id}"]` : patch.query)
            let resultSet = await evaluate(query, {
              dataset: db.json,
              params: params
            })
            let results = await resultSet.get()
            if (!Array.isArray(results)) results = [results]
            for (const result of results) {
              //Skip if not the specified revision
              if (patch.hasOwnProperty('ifRevisionID') && result._rev !== patch.ifRevisionID) {
                continue //Skip this invalid revision
              }

              //Create the transaction
              backend._createTransaction(
                transactions,
                req,
                result,
                result,
                transactionId,
                'update',
                mut
              )

              //Unset a data item
              if (patch.hasOwnProperty('unset')) {
                //Unset is an array not object
                for (let key of patch.unset) {
                  backend._setValue(result, key, null, true)
                }
              }

              //Create object value if it does not exist
              if (patch.hasOwnProperty('setIfMissing')) {
                for (let [key, value] of Object.entries(patch.setIfMissing)) {
                  backend._setValue(result, key, value, false)
                }
              }

              //Set and object value
              if (patch.hasOwnProperty('set')) {
                for (let [key, value] of Object.entries(patch.set)) {
                  //console.log("Set",key,value)
                  backend._setValue(result, key, value, true)
                }
              }

              //Increase an object value
              if (patch.hasOwnProperty('inc')) {
                for (let [key, value] of Object.entries(patch.inc)) {
                  backend._setValue(result, key, 0, true, function(rec) {
                    return Number(rec) + value
                  })
                }
              }

              //Decrease an object value
              if (patch.hasOwnProperty('dec')) {
                for (let [key, value] of Object.entries(patch.dec)) {
                  backend._setValue(result, key, 0, true, function(rec) {
                    return Number(rec) - value
                  })
                }
              }

              //Insert data
              if (
                patch.hasOwnProperty('insert') &&
                patch.insert.hasOwnProperty('items') &&
                Array.isArray(patch.insert.items)
              ) {
                let action = patch.insert,
                  query,
                  pos = 0,
                  replace = false
                if (action.hasOwnProperty('after')) {
                  query = action.after
                  pos = 1
                }
                if (action.hasOwnProperty('before')) {
                  query = action.before
                }
                if (action.hasOwnProperty('replace')) {
                  query = action.replace
                  replace = true
                }
                if (query) {
                  backend._setValue(result, query, action.items, {
                    pos,
                    replace
                  })
                } else {
                  throw `No selection query`
                }
              }

              if (patch.hasOwnProperty('diffMatchPatch')) {
                for (let [key, patches] of Object.entries(patch.diffMatchPatch)) {
                  //console.log("Patch",result,key)
                  backend._setValue(result, key, '', true, function(
                    rec,
                    parent,
                    index,
                    data,
                    mode
                  ) {
                    if (!mode == true) return rec //Only patch on update
                    let patch = dmp.patch_apply(dmp.patch_fromText(patches), rec)
                    if (patch[1][0]) rec = patch[0]
                    else console.log('Failed to patch', JSON.stringify(patch, null, 2))
                    return rec
                  })
                }
              }
            }
          }

          //Log item with missing processing
          else {
            throw (`Unhandled mutation (${mutType})`, mut)
          }
        }
      //If we have responses we have changed the db
      if (transactions.length > 0) db.isDirty = true
      //Create results based on the responses
      let results = []
      let ids = req.query && Boolean(req.query.returnIds)
      let docs = req.query && Boolean(req.query.returnDocuments)

      for (const rec of transactions) {
        //Change _rev now we are finished
        if (rec.result) {
          rec.result._rev = transactionId
          rec.result._updatedAt = new Date().toISOString()
        }
        if (ids || docs) {
          let res = {}
          if (ids) res.id = rec.documentId
          if (docs) res.document = rec.result || rec.previous
          if (rec.transition == 'appear') res.operation = 'create'
          else if (rec.transition == 'disappear') res.operation = 'delete'
          else res.operation = 'update'
          results.push(res)
        }
      }
      //console.log("End-Result",JSON.stringify(results,null,2))
      return {
        transactionId: transactionId,
        results: results
      }
    } catch (err) {
      console.log('Mutation failed', err)
      db.error = true //Rollback change
    } finally {
      if (!db.error) {
        backend._sendChangesToAll(transactions, dbName, dataSet)
        if (db.isDirty) backend.saveDb(dbName, dataSet) //Write changed to file
        //Trigger the listeners
        if (transactions.length > 0) {
          if (!backend.options.writeDelay)
            await backend._writeTransaction(transactions, dbName, dataSet)
          else backend._writeTransaction(transactions, dbName, dataSet)
        }
      }
      //Release DB
      db.lock.release()
    }
  },

  //Perform a request on db, return a promise
  //{ "ms": <server-side processing time>, "query": <submitted query>, "result": <query result> }
  query: async function(req, dbName, dataSet) {
    try {
      let startTime = Date.now()
      if (!dbName) dbName = backend.dbNameFromReq(req)
      if (!dataSet) dataSet = backend.dataSetFromReq(req)
      let db = backend.getDb(dbName, dataSet)
      let queryStr = backend._queryString(req)
      let query = parse(queryStr)
      let params = backend._queryParams(req)
      let rs = await evaluate(query, {dataset: db.json, params: params})
      let result = await rs.get()

      return {
        ms: Date.now() - startTime,
        query: queryStr,
        result: result //!result ? [] : result
      }
    } catch (err) {
      console.log('Query error ', backend._queryString(req))
      throw err
    }
  },

  //Return a full document
  documents: async function(req, dbName, dataSet) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    if (!dataSet) dataSet = backend.dataSetFromReq(req)
    let db = backend.getDb(dbName, dataSet)
    let str = req._parsedUrl ? req._parsedUrl.pathname : ''
    let ids = str.substr(str.lastIndexOf('/') + 1).split(',')
    // for (let index = ids.length-1; index>=0; index--) {
    for (let index = 0; index < ids.length; index++) {
      let rs = await evaluate(parse(`*[_id=="${ids[index]}"][0]`), {
        dataset: db.json
      })
      let results = await rs.get()
      if (results) return {documents: [results]}
    }
    return {documents: []}
  },
  
// TODO: FIX ME
  projects: async function(req,dbName,dataSet) {
     if (!dbName) dbName = backend.dbNameFromReq(req)
    if (!dataSet) dataSet = backend.dataSetFromReq(req)
    let db = backend.getDb(dbName, dataSet)
    //DataSets
    return [
      {
		"filter": '_id in path("**")',
		"grants": ["read", "update", "create", "history"],
          permissions:["read", "update", "create", "history"],
	}
    ]
    /*
    return [{
      "projectUserId": backend.userIdFromReq(req),
      "roles": [
          {
            "name": "administrator",
            "title": "Administrator"
          }
        ],
      "isRobot": false,
     },
    {
      "id": dbName,
      "displayName": "My Sanity Project",
      "studioHost": null,
      "isBlocked": false,
      "isDisabled": false,
      "isDisabledByUser": false,
      "metadata": {
        "color": "#c7494b"
      },
      "maxRetentionDays": 3,
      "createdAt": "2020-05-08T12:09:53.563Z",
      "updatedAt": "2020-05-08T12:13:49.191Z",
      "deletedAt": null,
      "organizationId": null,
      "members": [     
        {
        "id": backend.userIdFromReq(req),
        "role": "administrator",
        "isRobot": false,
        "isCurrentUser": true
      }
    ]
    
    return   [{
      "id": dbName,
      "displayName": "My Sanity Project",
      "studioHost": null,
      "isBlocked": false,
      "isDisabled": false,
      "isDisabledByUser": false,
      "metadata": {
        "color": "#c7494b"
      },
      "maxRetentionDays": 3,
      "createdAt": "2020-05-08T12:09:53.563Z",
      "updatedAt": "2020-05-08T12:13:49.191Z",
      "deletedAt": null,
      "organizationId": null,
      "members": [     
        {
        "id": backend.userIdFromReq(req),
        "role": "administrator",
        "isRobot": false,
        "isCurrentUser": true
      }
      ],
      "pendingInvites": 0,
      {
      "projectUserId": backend.userIdFromReq(req),
      "roles": [
          {
            "name": "administrator",
            "title": "Administrator"
          }
        ],
      "isRobot": false,
     },
      "sanity.project": [
        {
          "grants": [
            {
              "name": "createSession",
              "params": {}
            },
            {
              "name": "delete",
              "params": {}
            },
            {
              "name": "deployStudio",
              "params": {}
            },
            {
              "name": "read",
              "params": {}
            },
            {
              "name": "update",
              "params": {}
            }
          ],
          "config": {}
        }
      ]
    }]
    */
  },

  //retrun all datasets created
  datasets: async function(req, dbName) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    let results = []
    fs.readdirSync(backend.options.dbDir).forEach(file => {
      if (file.indexOf(dbName) == 0) {
        results.push({
          name: file.substr(dbName.length + 1).split('.')[0],
          alcMode: 'public'
        })
      }
      //console.log(file)
    })
    return results
  },

  //Return an images
  images: function(req, res, next) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    if (!dataSet) dataSet = backend.dataSetFromReq(req)
    //let db = backend.getDb(dbName,dataSet)
    throw 'Images not implemented'
  },

  // Middleware for GET /listen endpoint
  listen: async function(req, res, next) {
    // Mandatory headers and http status to keep connection open
    const headers = {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache'
    }
    res.writeHead(200, headers)

    //Channel, needs to be linked to
    //split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0)
    let channel = nanoid()

    // After client opens connection send all nests as string
    //events: ["welcome", "mutation", "reconnect"]
    const data = `event: welcome\ndata: {"listenerName": "${channel}"}\n\n`
    res.write(data)

    // Later we'll iterate it and send updates to each client
    const newClient = {
      id: nanoid(),
      channel: channel,
      query: parse(backend._queryString(req)),
      params: backend._queryParams(req),
      iResult: req.query && Boolean(req.query.includeResult),
      iRevision: req.query && Boolean(req.query.includePreviousRevision),
      visibility: req.query && req.query.visibility ? req.query.visibility : 'transaction',
      dbName: backend.dbNameFromReq(req),
      dataSet: backend.dataSetFromReq(req),
      res
    }
    backend.clients.push(newClient)

    // When client closes connection we update the clients list
    // avoiding the disconnected one
    req.on('close', () => {
      //console.log(newClient.id,`Connection closed`)
      backend.clients = backend.clients.filter(c => c.id !== newClient.id)
    })
  },

  addImage: async function(dbName, dataSet, fileName, fullName, url) {
    let db = backend.getDb(dbName, dataSet)
    return new Promise((accept, reject) => {
      const image = sharp(fullName)
      image.metadata().then(function(metadata) {
        let flHeight = metadata.height,
          flWidth = metadata.width,
          flExt = fileName.split('.')[1],
          flRatio = Number((flWidth / flHeight).toFixed(1))
        let id = nanoid().replace('-', '_')
        //Fix path base on name space
        let flName = id + '-' + flWidth + 'x' + flHeight + '.' + flExt
        let flPath = dbName + '/' + dataSet + '/' + flName
        let flUrl = backend.namespace
          ? '/images/' + flPath
          : '/' + backend.apiVersion() + '/images/' + flPath
        let ret = {
          _id: 'image-' + id + '-' + flWidth + 'x' + flHeight + '-' + flExt,
          _type: 'sanity.imageAsset', // type is prefixed by sanity schema
          assetId: nanoid(),
          path: backend.options.dbDir + flPath,
          url: flUrl,
          originalFilename: fileName,
          size: fs.statSync(fullName).size, //File size in bytes
          metadata: {
            dimensions: {
              height: flHeight,
              width: flWidth,
              aspectRatio: flRatio
            }
          }
        }
        image
          .toFile(backend.options.dbDir + dbName + '/' + dataSet + '/' + flName)
          .then(info => {
            fs.unlinkSync(fullName)
            db.json.push(ret)
            db.isDirty = true
            backend.saveDb(dbName, dbName)
            accept({document: ret})
          })
          .catch(err => {
            reject(err)
          })
      })
    })
  },

  //https://www.sanity.io/docs/http-api-assets
  uploadImages: async function(req, dbName, dataSet) {
    return new Promise((accept, reject) => {
      if (!dbName) dbName = backend.dbNameFromReq(req)
      if (!dataSet) dataSet = backend.dataSetFromReq(req)
      let db = backend.getDb(dbName, dataSet)
      let fileName = req.query.filename
      let fullName = backend.options.dbDir + dbName + '/' + dataSet + '/' + fileName
      let file = fs.createWriteStream(fullName)
      req.pipe(file)
      file
        .on('finish', function done() {
          backend
            .addImage(dbName, dataSet, fileName, fullName, req.protocol + '://' + req.headers.host)
            .then(accept)
            .catch(reject)
        })
        .on('error', reject)
    })
  },

  imagePath: async function(req, dbName, dataSet) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    // /b7d36f76396e09c3df4dabbaec0ae63fc874833d-1500x778.jpg?rect=361,0,778,778&w=80&h=80&fit=crop
    let str = (req._parsedUrl ? req._parsedUrl.pathname : '').split('/')
    if (backend.namespace) dataSet = backend.namespace
    else if (!dataSet) dataSet = str[str.length - 2]

    let fileName = backend.options.dbDir + dbName + '/' + dataSet + '/' + str[str.length - 1]
    //Check if file exists
    if (fs.existsSync(fileName)) {
      if (req.sws && req.sws.query && req.sws.query.w) {
        let w = Number(req.sws.query.w)
        let h = Number(req.sws.query.h) ? Number(req.sws.query.h) : 0
        let cfileName =
          backend.options.dbDir +
          dbName +
          '/' +
          dataSet +
          '/cache/' +
          w +
          'x' +
          h +
          '-' +
          str[str.length - 1]
        //Resize the image to specified with
        if (!fs.existsSync(cfileName)) {
          if (!fs.existsSync(backend.options.dbDir + dbName + '/' + dataSet + '/cache')) {
            fs.mkdirSync(backend.options.dbDir + dbName + '/' + dataSet + '/cache', {
              recursive: true
            })
          }
          //Create the image
          const image = await sharp(fileName)
          await image.resize({width: w}).toFile(cfileName)
        }
        fileName = cfileName
      }
    } else {
      fileName = backend.options.dbDir + '/../notfound.png'
    }
    return resolvePath(fileName)
  },

  historyTransactions: async function(req, dbName, dataSet) {
    if (!dbName) dbName = backend.dbNameFromReq(req)
    if (!dataSet) dataSet = backend.dataSetFromReq(req)
    let fullName = dbName + '/' + dataSet
    let fileName = backend.options.dbDir + fullName + '.ndjson'
    let ret = []
    let str = req._parsedUrl ? req._parsedUrl.pathname : ''
    let ids = str.substr(str.lastIndexOf('/') + 1).split(',')
    for (let index = 0; index < ids.length; index++) {
      if (str) str += ' || '
      str += `_id=="${ids[index]}"`
    }
    const fileStream = fs.createReadStream(fileName)
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    })

    for await (const line of rl) {
      // Each line in file will be successively available here as `line`.
      //console.log(`Line from file: ${line}`)
      if (line) {
        let json = JSON.parse(line)
        json.documentIDs.forEach(id => {
          if (ids.indexOf(id) >= 0) {
            //Work arround old data
            ret.push(Object.assign({effects:[]},json))
          }
        })
      }
    }
    return ret
  }
} //End of Backend

//We separated the router out of object to maintain readability
backend.router = function(app, options = {}) {
  backend.options = mergeDeep(backend.options, options)
  if (process.env.JWT_SECRET) backend.options.secret = process.env.JWT_SECRET

  //Create the session, if there is a other secret set
  app.use(
    session({
      name: 'sanitySession',
      store: new FileStore(Object.assign({}, options.fileStore || {})),
      secret: backend.options.secret,
      resave: true,
      saveUninitialized: true
    })
  )

  //User login, me will return the current person
  app.all(
    ['/' + backend.apiVersion() + '/users/:id', `/users/:id`],
    backend.verifyJWT,
    async function(req, res, next) {
      if (req.params.id === 'me') {
        res.json({
          id: backend.userIdFromReq(req),
          name: 'Sierk Hoeksma',
          email: 'sjhoeksma@welcome.com',
          profileImage:
            'https://lh6.googleusercontent.com/-BjhAp8p8nYA/AAAAAAAAAAI/AAAAAAAAAAA/AAKWJJO2r28j2ouh2t7bOcrkNSSJzykK6g/photo.jpg',
          role: 'administrator',
          //roles: ['administrator'],
        })
      } else {
        res.json({
          createdAt: '2020-04-26T19:14:53.881Z',
          displayName: 'Sierk Hoeksma',
          familyName: 'Hoeksma',
          givenName: 'Sierk',
          id: req.params.id,
          imageUrl:
            'https://lh6.googleusercontent.com/-BjhAp8p8nYA/AAAAAAAAAAI/AAAAAAAAAAA/AMZuucmRIrV4uaHaPQxylPKDWUj2ONZopA/photo.jpg',
          isCurrentUser: backend.userIdFromReq(req) === req.params.id,
          middleName: null,
          projectId: backend.dbNameFromReq(req),
          roles: ['administrator'],
          updatedAt: '2020-05-15T09:47:15.415Z'
        })
      }
    }
  )

  //We allow cors actions
  app.post(['/' + backend.apiVersion() + '/cors', '/cors'], function(req, res, next) {
    res.json({allowed: true})
  })

  //Check if version of software are up-to-date
  app.get(['/' + backend.apiVersion() + '/versions', '/versions'], function(req, res, next) {
    fetch(
      'https://api.sanity.io/' +
        backend.apiVersion() +
        '/versions' +
        req.url.substr(req.url.indexOf('?'))
    )
      .then(fres => fres.json())
      .then(json => res.json(json))
  })

  //Response to a ping
  app.get(['/' + backend.apiVersion() + '/ping', '/ping'], function(req, res, next) {
    res.header('Content-Type', 'text/plain; charset=utf-8')
    res.send('PONG')
  })

  //Handle raw documents
  app.get(
    ['/' + backend.apiVersion() + '/data/doc/:dataSet/*', '/doc/:dataSet/*'],
    backend.verifyJWT,
    function(req, res, next) {
      backend.documents(req).then(data => {
        res.json(data)
      })
    }
  )

  //Create store of project databases, if still in cache return it otherwise return it
  app.get(['/' + backend.apiVersion() + '/data/query/:dataSet', '/query/:dataSet'], function(
    req,
    res,
    next
  ) {
    backend.query(req).then(data => {
      //console.log(data)
      res.json(data)
    })
  })
  
   //Create store of project databases, if still in cache return it otherwise return it
  app.get(['/' + backend.apiVersion() + '/projects/:dataSet/*', '/projects/:dataSet/*'], function(
    req,
    res,
    next
  ) {
    backend.projects(req).then(data => {
      //console.log(data)
      res.json(data)
    })
  })

  //Mutate a recrod
  app.post(
    ['/' + backend.apiVersion() + '/data/mutate/:dataSet', '/mutate/:dataSet'],
    backend.verifyJWT,
    function(req, res, next) {
      backend.mutate(req).then(data => {
        //console.log(data)
        res.json(data)
      })
    }
  )

  //Datasets
  app.get(['/' + backend.apiVersion() + '/datasets/*', '/datasets/*'], backend.verifyJWT, function(
    req,
    res,
    next
  ) {
    backend.datasets(req).then(data => {
      res.json(data)
    })
  })

  //Listen for changes
  app.get(
    ['/' + backend.apiVersion() + '/data/listen/:dataSet', '/listen/:dataSet'],
    backend.listen
  )

  //Images, https://www.sanity.io/docs/image-urls
  app.post(
    [
      '/' + backend.apiVersion() + '/assets/images/:dataSet',
      '/assets/images/:dataSet',
      '/images/:dataSet'
    ],
    backend.verifyJWT,
    function(req, res, next) {
      backend.uploadImages(req).then(data => {
        //console.log("Images",data)
        res.json(data)
      })
    }
  )

  app.get(
    [
      '/' + backend.apiVersion() + '/images/:dataSet/*',
      '/' + backend.apiVersion() + '/images/*/:dataSet/*',
      '/images/:dataSet/*'
    ],
    function(req, res, next) {
      backend.imagePath(req).then(fileName => {
        res.sendFile(fileName)
      })
    }
  )

  //Move this to addon module  and load from backend.options
  if (options.addons && options.addons.unsplash) {
    app.get(
      [
        '/' + backend.apiVersion() + '/addons/unsplash/photos/:id/download',
        '/addons/unsplash/photos/:id/download'
      ],
      backend.verifyJWT,
      function(req, res, next) {
        fetch(`https://api.unsplash.com/photos/${req.params.id}/download`, {
          headers: {
            Authorization: `Client-ID ${options.addons.unsplash.client_id}`
          },
          method: req.method
        })
          .then(fres => fres.json())
          .then(json => res.json(json))
      }
    )
    app.get(
      ['/' + backend.apiVersion() + '/addons/unsplash/photos', '/addons/unsplash/photos'],
      backend.verifyJWT,
      function(req, res, next) {
        fetch('https://api.unsplash.com/photos' + req.url.substr(req.url.indexOf('?')), {
          headers: {
            Authorization: `Client-ID ${options.addons.unsplash.client_id}`
          },
          method: req.method
        })
          .then(fres => fres.json())
          .then(json => res.json(json))
      }
    )
    app.get(
      [
        '/' + backend.apiVersion() + '/addons/unsplash/search/photos',
        '/addons/unsplash/search/photos'
      ],
      backend.verifyJWT,
      function(req, res, next) {
        fetch('https://api.unsplash.com/search/photos' + req.url.substr(req.url.indexOf('?')), {
          headers: {
            Authorization: `Client-ID ${options.addons.unsplash.client_id}`
          },
          method: req.method
        })
          .then(fres => fres.json())
          .then(json => res.json(json))
      }
    )
  }

  // mount grant
  let grantObj
  app.use(function(req, res, next) {
    if (!grantObj) {
      let url = backend.options.apiHost
        ? backend.options.apiHost
        : req.protocol + '://' + req.headers.host
      grantObj = grant(
        mergeDeep(
          {
            defaults: {
              callback: url + '/studio',
              origin: url,
              prefix: '/' + backend.apiVersion() + '/auth/login',
              transport: 'session',
              state: true,
              response: ['tokens', 'jwt', 'profile']
            }
          },
          backend.options.authentication
        )
      )
    }
    return grantObj(req, res, next)
  })

  app.all(['/' + backend.apiVersion() + '/auth/providers', '/auth/providers'], function(
    req,
    res,
    next
  ) {
    let url = backend.options.apiHost
      ? backend.options.apiHost
      : req.protocol + '://' + req.headers.host
    let providers = []
    for (const [key, el] of Object.entries(backend.options.authentication)) {
      if (key !== 'defaults' && el.enabled !== false) {
        providers.push({
          name: key,
          title: el.title || key,
          url: url + '/' + backend.apiVersion() + '/auth/login/' + key
        })
      }
    }

    res.json({
      providers: providers,
      thirdPartyLogin: false
    })
  })

  app.all(['/' + backend.apiVersion() + '/auth/testCookie', '/auth/testCookie'], function(
    req,
    res,
    next
  ) {
    res.send('Ok')
  })

  app.post(['/' + backend.apiVersion() + '/auth/logout', '/auth/logout'], function(req, res, next) {
    req.session.regenerate(err => {
      res.send()
    })
  })

  // /data/history/production/documents/1660d818-0813-43db-b60c-76d21c7be967,drafts.1660d818-0813-43db-b60c-76d21c7be967
  //http://localhost:3900/data/history/production/documents/1660d818-0813-43db-b60c-76d21c7be967,drafts.1660d818-0813-43db-b60c-76d21c7be967?revision=iqdp4l-smi-o4h-r6q-tyqhuhrwe
  app.get(
    [
      '/data/history/:dataSet/documents/*',
      '/' + backend.apiVersion() + '/data/history/:dataSet/documents/*'
    ],
    backend.verifyJWT,
    function(req, res, next) {
      backend
        .historyTransactions(req, backend.dbNameFromReq(req), req.params.dataSet)
        .then(data => {
          let ret = []
          data.forEach(rec => {
            if (rec.result && (!req.query.revision || rec.revision == req.query.revision))
              ret.push(rec.result)
          })
          res.json({documents: ret})
        })
    }
  )
  //http://localhost:3900/data/history/production/transactions/drafts.1660d818-0813-43db-b60c-76d21c7be967,1660d818-0813-43db-b60c-76d21c7be967?excludeContent=true
  app.get(
    [
      '/data/history/:dataSet/transactions/*',
      '/' + backend.apiVersion() + '/data/history/:dataSet/transactions/*'
    ],
    backend.verifyJWT,
    function(req, res, next) {
      backend
        .historyTransactions(req, backend.dbNameFromReq(req), req.params.dataSet)
        .then(data => {
          res.header('Content-Type', 'text/plain; charset=utf-8')
          let ex = req.query && Boolean(req.query.excludeContent)
          data.forEach(rec => {
            if (ex) delete rec.result
            res.write(JSON.stringify(rec))
            res.write('\n')
          })
          res.end()
        })
    }
  )

  //Create store of project databases, if still in cache return it otherwise return it
  app.all(['/' + backend.apiVersion() + '/*'], function(req, res, next) {
    console.log('No Handler for:', req._parsedUrl)
    next()
  })

  if (backend.options.writeDelay) {
    console.log('Write Delays Enabled')
    function flushDB() {
      backend.flushDBs()
    }

    setInterval(flushDB, backend.options.writeDelay)
  }
}

//Export the two functions
module.exports = backend
