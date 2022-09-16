const fs = require('fs')
const path = require('path')
const mergeDeep = require('./deepMerge')
//Create the options variable
var locOptions = {}
var locEnvFile = path.join(process.cwd(), 'config/env.json')
if (fs.existsSync(locEnvFile)) {
  locOptions = JSON.parse(fs.readFileSync(locEnvFile))
  console.log('Local config read')
}
var options = mergeDeep(JSON.parse(fs.readFileSync('env.json')), locOptions, process.env)
module.exports = options
