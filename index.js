const stream = require('readable-stream');  //https://nodejs.org/api/stream.html
const debug = require('debug');

class ParallelStream extends stream.Transform {
    /*
    Implement a variant of TransformStream that allows a configurable number of threads in parallel,
    Adds functionality to support array functions

    The key differences are ...
    subclasses should implement _parallel(data, encoding, cb) which has exactly same syntax as _transform in TransformStreams
    Or they can implement _transform (and not work in parallel)
     */

    constructor(options={}) {
        /*
        Create a new Parallel Stream
        options = {
            name            Set to a name to use in debugging (this.debug will be active on parallel-streams:<name>
            paralleloptions {
                limit: maximum number of threads to run in parallel
                retryms:    How long to wait before retrying if thread count exceeded,
                silentwait: Set to true to remove debugging when waiting
                },
            parallel(data, encoding, cb),   Function like transform(), including how to use push() and cb(err, data)
            init()          Called at initialization
        }

        Inherited from TransformStream:
        options {
            flush(cb)   runs at completion before the stream is closed, should call cb when complete.
            highWaterMark   int Sets how many data items can be queued up
        differences with TransformStream:
            do not pass transform() unless you intentionally are replacing the parallel behavior,
            objectMode is set to true by default.
         */
        const defaultopts = {
            objectMode: true, // Default to object mode rather than stream of bytes
        };  // Default to pushback after 3, will probably raise this
        let paralleloptions = Object.assign( { limit: undefined, count: 0, max: 0, retryms: 100, silentwait: false}, options.paralleloptions);
        delete options.paralleloptions;
        super(Object.assign(defaultopts, options));
        this.paralleloptions = paralleloptions;
        if (options.parallel) { this._parallel = options.parallel; }   // Optional function to replace _parallel implemented here
        this.name = options.name || "ParallelStream";
        this.debug = debug(`parallel-streams:${options.name.replace(' ','_')}`); // Debugger for this log stream
        if (typeof options.init === "function") options.init.call(this);
    }

    _final(cb) {
        if (this.paralleloptions.limit) {
            if (this.paralleloptions.count) {
                this.debug("waiting on %d of max %d threads to close", this.paralleloptions.count,this.paralleloptions.max);
                setTimeout(()=>this._final(cb), 1000);
                return;
            }
            if (this.paralleloptions.max) this.debug("Closing parallel. Was max= %d", this.paralleloptions.max);
        } else {
            this.debug("Closing");
        }
        cb();
    }

    _parallel(data, encoding, cb) {
        if (this.paralleloptions.transform) {
            this.paralleloptions.transform(data, encoding, cb);
        } else {
            cb(null, data)
            //throw new Error("Subclasses of ParallelStream must implement _parallel(data, encoding, cb) or pass to constructor");
        }
    }

    _transform(data, encoding, cb) {    // A search result got written to this stream
        let donecb = false;
        if (typeof encoding === 'function') { cb = encoding; encoding = null; } // Allow for missing parameter
        let name = this.name;
        if (this.paralleloptions.limit && (this.paralleloptions.count >= this.paralleloptions.limit)) {
            if (!this.paralleloptions.silentwait)
                this.debug("waiting %d ms for parallel availability using %d of %d", this.paralleloptions.retryms, this.paralleloptions.count, this.paralleloptions.limit);
            setTimeout(()=>this._transform(data, encoding, cb), this.paralleloptions.retryms);   // Delay 100ms and try again
            return;
        }
        try {
            this.paralleloptions.count++;
            if (this.paralleloptions.count > this.paralleloptions.max) this.paralleloptions.max = this.paralleloptions.count;
            this._parallel(data, encoding, (err, data) => {
                if (!this.paralleloptions.limit) {
                    donecb = true;
                    cb(err, data);
                } else {
                    if (!err)
                        this.push(data);
                }
                this.paralleloptions.count--;
            });
            if (this.paralleloptions.limit) {
                donecb = true;
                cb(null);   // Return quickly and allow push to pass it on
            }
        } catch(err) { // Shouldnt catch errors - they should only happen inside _parallel and be caught there, triggering cb(err)
            console.error(name, "._transform caught error from _parallel", err.message);
            this.paralleloptions.count--;
            if (!donecb)
                cb(err);
        }

    }

    //TODO Building on pattern in https://nodejs.org/api/stream.html#stream_implementing_a_transform_stream

    log(logfunction, options={}) {
        /*
        Log output using debug("parallel-streams:<name>"),
            `f(data)` should return an array suitable for passing to debug(),
            i.e. the first parameter can contain formatting like %s %d %o (see npm:debug for details)

            e.g. .log(data => ["Handling %o", data])

        input:  object
        output: same object
        */
        return this.pipe(
            new ParallelStream(Object.assign({
                parallel(data, encoding, cb) {
                    let a = logfunction(data);
                    a = Array.isArray(a) ? a : [a];
                    this.debug(...a);
                    cb(null, data) // Error in logfunction should through to catcher in _transform
                },
                highWaterMark: 99999,
                name: "log"
            },options))
        );
    }

    map(mapfunction, options={}) {
        /*
        Transform input data to output data like `Array.prototype.map()`
        */
        return this.pipe(
            new ParallelStream(Object.assign({
                parallel(o, encoding, cb) {
                    let p = mapfunction(o, options.async ? cb : undefined);
                    if (p instanceof Promise) {
                        p.then((data) => cb(null, data))
                            .catch((err) => cb(err));
                    } else {
                        if (!options.async) {   // If options.async then assume mapfunction called cb
                            cb(null, p);
                        }
                    }
                },
                name: "map"
            }, options))
        );
    }

    flatten(options={}) {
        /*
        input stream - of arrays
        output stream - expand arrays into a single stream

        Flatten a stream of arrays into a stream of items in those arrays,
        useful for example where a previous map call returns a list, each element of which requires independent processing.

        TODO could add options as to whether should handle single objs as well as arrays and whether to ignore undefined
         */
        // Usage example  writable.map(m => m*2, {name: "foo" }
        return this.pipe(
            new ParallelStream(Object.assign({
                parallel(oo, encoding, cb) {
                    if (Array.isArray(oo)) {
                        oo.forEach(o => this.push(o));
                    } else if ((typeof oo) !== "undefined") {
                        this.push(oo);
                    }
                    cb();
                },
                name: "flatten"
            }, options))
        );
    }

    filter(filterfunction, options={}) {
        /*
            filterfunction(data) => boolean  Filter function that returns true for items to output

            input stream: objects
            output stream: objects where f(data) returns true
            Usage example: `parallelstream.filter(m=>m>1 && m<4)`

         */
        return this.pipe(
            new ParallelStream(Object.assign({
                parallel(o, encoding, cb) {
                    if (filterfunction(o)) {
                        this.push(o)
                    }
                    cb();
                },
                name: "filter"
            }, options))
        );
    }

    slice(begin, end, options={}) {
        /*
        begin: first item to pass,
        end: one after last item
        input stream: objects
        output stream: objects[begin...end-1]
         */
        let ps = new ParallelStream(Object.assign({
            parallel(o, encoding, cb) { // Note 'this' is ps inside the function
                if ((begin <= this.count) && ((typeof end  === "undefined")|| this.count < end)) {
                    this.push(o);
                }
                this.count++; //Note count is how many processed, not how many pushed
                cb();
            },
            name: "slice"
        }, options));
        ps.count = 0;
        return this.pipe(ps);
    }

    fork(nstreams, options={}) {
    /*
        Fork a stream into multiple streams,
        nstreams    Number of streams to fork into
        returns     Array of Parallel streams.

        Usage of fork is slightly different
        let ss =  parallelstream.fork(2).streams;
     ss[0].log ...; ss[1].filter.... etc

        Warning all streams need to properly end, e.g. with .reduce() or pushback on one fork could effect all of them
      */
        const defaultoptions = {
            name: "fork",
        }
        let ws = new stream.Writable(Object.assign({
            objectMode: true,
            write(o, encoding, cb) {
                if (typeof encoding === 'function') {
                    cb = encoding;
                    encoding = null;
                } // Allow missing encoding
                try {
                    let firstpushback = this.streams.map(s => s.write(o) ? false : s).find(s => !!s); // Writes to all streams, catches first that has pushback
                    if (firstpushback) {
                        this.debug("Pushback from %s", firstpushback.name);
                        firstpushback.once("drain", cb); // Just wait on first pushback to be ready, should be ok as if 2nd hasn't cleared it will pushback on next write
                    } else {
                        cb();
                    }
                } catch (err) { // Unlikely to have an error since should catch in pushbackable fork
                    this.streams.map(s => s.destroy(new Error(`Failure in ${this.name}._write: ${err.message}`)));
                    cb(err);
                }
            },
            final(cb) {
                this.streams.map(s => s.end());
                cb();
            }
        }, options));
        ws.streams = Array.from(Array(nstreams)).map(unused=>new ParallelStream(Object.assign(defaultoptions, options)));
        return this.pipe(ws)
    }
    uniq(uniqfunction, options={}) {
        /*
        uniqfunction(data) => string: return a string that can be used to compare uniqueness (for example an id)
        options { uniq: optional array to use for checking uniqueness (allows testing against existing list)
        }
        input stream: objects
        output stream: subset of objects
         */
        let uf = (typeof uniqfunction === "function") ? uniqfunction : function(a) {return a};
        let uniqarr = Array.isArray(options.uniq) ? options.uniq : [];
        let ps = new ParallelStream(Object.assign({
            parallel(o, encoding, cb) { // Note 'this' is ps inside the function
                let id = uf(o);
                if (! uniqarr.includes(id) ) {
                    uniqarr.push(id);
                    this.push(o);   // Only push if uniq
                } else {
                    debug("Duplicate with id=%s", id);
                }
                cb();
            },
            name: "uniq"
        }, options));
        return this.pipe(ps);
    }

    static from(arr, options={}) { // Static
        /*
        Create a new ParallelStream from an array, usually this will be the start of any pipeline of streams.
        arr Array of any kind of object
        output: Elements of arr, in order.
        */
        // noinspection JSUnresolvedFunction
        let ediblearr = Array.from(arr); // Shallow copy.
        let through = new ParallelStream(Object.assign({objectMode: true, highWaterMark: 3, name: "EdibleArray"},options));
        try {
            _pushbackablewrite(); // Will .end stream when done
        } catch (err) {
            // Would be unexpected to see error here, more likely _parallel will catch it asynchronously
            console.error(err);
            through.destroy(new Error(`Failure in ${through.name}.s_fromEdibleArray: ${err.message}`))
        }
        return through;

        function _pushbackablewrite() { // Asynchronous, retriggerable
            // Note consumes eatable array from parent
            try {
                let i;
                while (typeof(i = ediblearr.shift()) !== "undefined") {
                    if (!through.write(i)) { // It still got written, but there is pushback
                        this.debug("Pushback from %s, %d items left", through.name, ediblearr.length);
                        through.once("drain", _pushbackablewrite);
                        return; // Without finishing
                    }
                } //while
                // Notice the return above will exit if sees backpressure
                through.end();    // Only end on final loop
            } catch(err) {
                console.error(err);
                through.destroy(new Error(`Failure in ${through.name}._pushbackablewrite: ${err.message}`))
            }
        }
    }
    reduce(reducefunction, initialvalue, finalcb, options={}) {
        /*

         */
        if (typeof finalcb === "object") { options = finalcb; finalcb = undefined; }
        let ps = new ParallelStream(Object.assign({
            name: "reduce",
            parallel(data, encoding, cb) {
                if (!this.i && typeof this.acc === "undefined") { // No initialvalue so use first element
                    this.acc = data;
                    this.i++;   // Sets this.i for 1 for first call to reducefunction
                } else {
                    if (reducefunction) { this.acc = reducefunction.call(this, this.acc, data, this.i++);}
                };
                cb() // Note doesnt push
            },
            flush(cb) {
                if (this.paralleloptions.limit && this.paralleloptions.count) {
                    setTimeout(() => this.flush.call(this, cb), 1000);
                } else {
                    if (finalcb) finalcb.call(this, this.acc);
                    cb()
                } },
        }, options));
        ps.i = 0;
        ps.acc = initialvalue;
        // Init will be run by Parallel constructor
        this.pipe(ps);

    }

}
exports = module.exports = ParallelStream;
