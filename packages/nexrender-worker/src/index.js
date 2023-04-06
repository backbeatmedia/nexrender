const { createClient } = require('@nexrender/api')
const { init, render } = require('@nexrender/core')
const { getRenderingStatus } = require('@nexrender/types/job')
// const { spawn } = require('child_process')
const os = require('os');

const NEXRENDER_API_POLLING = process.env.NEXRENDER_API_POLLING || 30 * 1000;
const NEXRENDER_TOLERATE_EMPTY_QUEUES = process.env.NEXRENDER_TOLERATE_EMPTY_QUEUES || 0;
var emptyReturns = 0;

/* TODO: possibly add support for graceful shutdown */
let active = true;

const delay = amount => (
    new Promise(resolve => setTimeout(resolve, amount))
)

const nextJob = async (client, settings) => {
    do {
        try {
            let job = await (settings.tagSelector ?
                await client.pickupJob(settings.tagSelector) :
                await client.pickupJob()
            );

            if (job && job.uid) {
                emptyReturns = 0;
                return job
            } else {
                // no job was returned by the server. If enough checks have passed, and the exit option is set, deactivate the worker
                emptyReturns++;
                if (settings.exitOnEmptyQueue && emptyReturns > settings.tolerateEmptyQueues) active = false;
            }

        } catch (err) {
            if (settings.stopOnError) {
                throw err;
            } else {
                console.error(err)
                console.error("render proccess stopped with error...")
                console.error("continue listening next job...")
            }
        }

        if (active) await delay(settings.polling || NEXRENDER_API_POLLING)
    } while (active)
}

/**
 * Starts worker "thread" of continious loop
 * of fetching queued projects and rendering them
 * @param  {String} host
 * @param  {String} secret
 * @param  {Object} settings
 * @return {Promise}
 */
const start = async (host, secret, settings, headers) => {

    console.log(`index.js invoke settings = ${JSON.stringify(settings)}`);

    settings = init(Object.assign({}, settings, {
        logger: console,
    }))

    console.log(`index.js after parse/push settings = ${JSON.stringify(settings)}`);

    if (typeof settings.tagSelector == 'string') {
        settings.tagSelector = settings.tagSelector.replace(/[^a-z0-9, ]/gi, '')
    }
    // if there is no setting for how many empty queues to tolerate, make one from the
    // environment variable, or the default (which is zero)
    if (!(typeof settings.tolerateEmptyQueues == 'number')) {
        settings.tolerateEmptyQueues = NEXRENDER_TOLERATE_EMPTY_QUEUES;
    }

    const client = createClient({ host, secret, headers });

    do {
        let job = await nextJob(client, settings);

        // if the worker has been deactivated, exit this loop
        if (!active) break;

        job.state = 'started';
        job.startedAt = new Date()

        try {
            await client.updateJob(job.uid, job)
        } catch (err) {
            console.log(`[${job.uid}] error while updating job state to ${job.state}. Job abandoned.`)
            console.log(`[${job.uid}] error stack: ${err.stack}`)
            continue;
        }

        try {
            job.onRenderProgress = (job) => {
                try {
                    /* send render progress to our server */
                    client.updateJob(job.uid, getRenderingStatus(job))
                } catch (err) {
                    if (settings.stopOnError) {
                        throw err;
                    } else {
                        console.log(`[${job.uid}] error occurred: ${err.stack}`)
                        console.log(`[${job.uid}] render proccess stopped with error...`)
                        console.log(`[${job.uid}] continue listening next job...`)
                    }
                }
            }

            job.onRenderError = (job, err /* on render error */) => {
                job.error = [].concat(job.error || [], [err.toString()]);
            }

            job = await render(job, settings); {
                job.state = 'finished';
                job.finishedAt = new Date()
            }

            await client.updateJob(job.uid, getRenderingStatus(job))
        } catch (err) {
            job.error = [].concat(job.error || [], [err.toString()]);
            job.errorAt = new Date();
            job.state = 'error';

            await client.updateJob(job.uid, getRenderingStatus(job)).catch((err) => {
                if (settings.stopOnError) {
                    throw err;
                } else {
                    console.log(`[${job.uid}] error occurred: ${err.stack}`)
                    console.log(`[${job.uid}] render proccess stopped with error...`)
                    console.log(`[${job.uid}] continue listening next job...`)
                }
            });

            if (settings.stopOnError) {
                throw err;
            } else {
                console.log(`[${job.uid}] error occurred: ${err.stack}`)
                console.log(`[${job.uid}] render proccess stopped with error...`)
                console.log(`[${job.uid}] continue listening next job...`)
            }
        }
    } while (active)

    console.log(`index.js end of run settings = ${JSON.stringify(settings)}`);

    if (settings.shutdown) {

        const platform = os.platform();

        if (platform.toLowerCase().indexOf('darwin') !== -1) { // mac
            console.log('mac shutdown');
            // spawn('shutdown', ['-h','now']);

        } else if (platform.toLowerCase().indexOf('linux') !== -1) { // linux
            console.log('linux shutdown');
            // spawn('shutdown', ['now']);

        } else { // windows
            console.log('windows shutdown');
            // spawn('shutdown', ['-s']);
        }

    } else {
        console.log('no shutdown');
    }
}

module.exports = { start }

