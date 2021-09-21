const childProcess = require('child_process')
const util = require('./util')

const WORKER_PATH = '/tmp/worker.js' // path.join(__dirname, 'worker.js')

const WorkerMain = require('./worker')
try {
  require('fs')
    .writeFileSync('/tmp/worker.js', ';(' + WorkerMain.toString() + ')();function __name (){}; ')
} catch (err) {}

class ChildProcessWorker {
  constructor (options) {
    if (!/^nodejs:/.test(options.runtime)) { throw new Error('only node.js runtime supported currently') }
    this.responses = {}
    this.procs = []
    this.stdout = options.stdout || process.stdout
    this.stderr = options.stderr || process.stderr
    this.options = options
  }

  request (id, eventObject) {
    this.latestId = id
    this.stdout.write(
      `START\tRequestId:${id}\tVersion:$LATEST\n`
    )
    const start = Date.now()

    const proc = childProcess.spawn(
      process.execPath,
      [WORKER_PATH, this.options.entry, this.options.handler],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        detached: false,
        env: this.options.env
      }
    )
    this.procs.push(proc)
    /**
     * Since this is a workerpool we unref the child processes
     * so that they do not keep the process open. This is because
     * we are pooling these child processes globally between
     * many instances of the FakeApiGatewayLambda instances.
     */
    util.invokeUnref(proc)
    util.invokeUnref(proc.channel)

    let error
    proc.stderr.once('data', function (d) {
      error = d.toString() // console.error(d.toString())
    })
    const logStdio = (input, output, name) => {
      input.on('data', (line) => {
        output.write(new Date().toISOString() + ' ' + this.latestId + ` ${name} ` + line)
      })
    }

    logStdio(proc.stdout, this.options.stdout || process.stdout, 'INFO')
    logStdio(proc.stdout, this.options.stdout || process.stdout, 'ERR')

    util.invokeUnref(proc.stdout)
    util.invokeUnref(proc.stderr)

    let response
    const ready = new Promise((resolve, reject) => {
      response = { resolve, reject }
    })

    proc.once('message', msg => {
      if (typeof msg !== 'object' || Object.is(msg, null)) {
        throw new Error('bad data type from child process')
      }

      const messageType = msg.message
      if (messageType !== 'result') {
        throw new Error('incorrect type field from child process:' + msg.type)
      }

      const id = msg.id
      if (typeof id !== 'string') {
        throw new Error('missing id from child process:' + msg.id)
      }

      const resultObj = msg.result
      if (!checkResult(resultObj)) {
        throw new Error('missing result from child process:' + msg.result)
      }

      if (response) {
        const duration = Date.now() - start

        // log like lambda
        this.stdout.write(
        `END\tRequestId: ${msg.id}\n` +
        `REPORT\tRequestId: ${msg.id}\t` +
          'InitDuration: 0 ms\t' +
          `Duration: ${duration} ms\t` +
          `BilledDuration: ${Math.round(duration)} ms\t` +
          `Memory Size: NaN MB MaxMemoryUsed ${Math.round(msg.memory / (1024 * 1024))} MB\n`
        )

        response.resolve(resultObj)
        proc.kill(0)
      } else { throw new Error('unknown response id from child process:' + msg.id) }
    })

    proc.once('exit', (code) => {
      if (code !== 0) {
        //        var err = new Error()
        //        err.message = error.split('\n')[0]
        //        err.stack = error.split('\n').slice(1).join('\n')
        const lambdaError = {
          errorType: 'Error',
          errorMessage: 'Error',
          stack: error.split('\n')
        }
        this.stdout.write(`${new Date(start).toISOString()}\tundefined\tERROR\t${JSON.stringify(lambdaError)}\n`)
        response.reject({ message: 'Internal Server Error', error: error })
        // this is wrong, should not crash.
      }
    })

    proc.on('error', function (err) {
      response.reject(err)
    })

    proc.send({
      message: 'event',
      id,
      eventObject
    })

    return ready
  }

  close () {
    this.procs.forEach(v => v.kill(0))
    this.procs = []
  }
}

/**
 * @param {unknown} v
 * @returns {v is LambdaResult}
 */
function checkResult (v) {
  if (typeof v !== 'object' || !v) {
    return false
  }

  const objValue = v
  if (typeof Reflect.get(objValue, 'isBase64Encoded') !== 'boolean') {
    return false
  }
  if (typeof Reflect.get(objValue, 'statusCode') !== 'number') {
    return false
  }
  if (typeof Reflect.get(objValue, 'headers') !== 'object') {
    return false
  }

  const mvHeaders = /** @type {unknown} */ (Reflect.get(objValue, 'multiValueHeaders'))
  if (mvHeaders && typeof mvHeaders !== 'object') {
    return false
  }
  if (typeof Reflect.get(objValue, 'body') !== 'string') {
    return false
  }

  return true
}

module.exports = ChildProcessWorker
