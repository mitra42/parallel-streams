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
            verbose         To get console logging on cb - useful when figuring out why prematurely closing
            name            Set to a name to use in debugging (this.debug will be active on parallel-streams:<name>
            paralleloptions { # Note this is copied, so can reuse same structure
                limit: maximum number of threads to run in parallel
                retryms:    How long to wait before retrying if thread count exceeded,
                silentwait: Set to true to remove debugging when waiting
                },
            parallel(data, encoding, cb),   Function like transform(), including how to use push() and cb(err, data)
            flush(cb)                       Function as for TaransformStream called once receives end , call cb when data flushed
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
        this.verbose = options.verbose;
        this.justReportError = options.justReportError;
        if (options.parallel) { this._parallel = options.parallel; }   // Optional function to replace _parallel implemented here
        this.name = options.name || "ParallelStream";
        this.debug = debug(`parallel-streams:${options.name.replace(' ','_')}`); // Debugger for this log stream
        if (typeof options.init === "function") options.init.call(this);
    }

    _final(cb) {
        if (this.paralleloptions.limit) {
            // If running parallel then allow all threads to finish
            if (this.paralleloptions.count) {
                this.debug("waiting on %d of max %d threads to close", this.paralleloptions.count,this.paralleloptions.max);
                setTimeout(()=>this._final(cb), 1000);
                return;
            }
            if (this.paralleloptions.max || this.verbose) this.debug("Closing parallel. Was max= %d", this.paralleloptions.max);
            // Drop through and call the cb if all parallel done, so didn't recurse
        } else {
            this.debug("Closing");
        }
        cb();   // This cb is what calls flush(cb) if defined and when flush calls cb it does the writablestream.end()
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
            this._parallel(data, encoding, (...args) => {
                let err = args.shift();
                if (this.justReportError) { // Can skip errors, this might or might not work but sometimes dont want an error (e.g. file read failure) flowing down
                    debug("Error caught in Parallel Streams._transform");
                    err = null;
                }
                let hasdata = args.length == 1;
                if (!this.paralleloptions.limit) {
                    donecb = true;
                    if (this.verbose) debug("Callback not parallel")
                    cb(err, args.shift());      // This should automatically handle pushback on non-parallel streams
                } else if (!err && hasdata) {  // If no arguments, then didn't explicitly send data (e.g. from cb()) so don't push undefined.   cb(null, undefined) will cause a push
                    console.assert(args[0] !== null, "You almost certainly don't want to be sending null - end undefined if that's what you want")
                    this.push(args.shift());
                }
                this.paralleloptions.count--;
            });
            if (this.paralleloptions.limit) {
                donecb = true;
                if (this.verbose) debug("Callback parallel")
                cb(null);   // Return quickly and allow push to pass it on
            }
        } catch(err) { // Shouldnt catch errors - they should only happen inside _parallel and be caught there, triggering cb(err)
            console.error(name, "._transform caught error from _parallel", err.message);
            this.paralleloptions.count--;
            if (!donecb) {
                if (this.verbose) debug("Callback on error");
                cb(err);
            }
        }

    }
    static log(logfunction, options={}) {
        /*
        Log output using debug("parallel-streams:<name>"),
            `f(data)` should return an array suitable for passing to debug(),
            i.e. the first parameter can contain formatting like %s %d %o (see npm:debug for details)

            e.g. .log(data => ["Handling %o", data])

        input:  object
        output: same object
        */
        return new ParallelStream(Object.assign({
            parallel(data, encoding, cb) {
                let a = logfunction(data);
                a = Array.isArray(a) ? a : [a];
                this.debug(...a);
                cb(null, data) // Error in logfunction should through to catcher in _transform
            },
            highWaterMark: 99999,
            name: "log"
        },options));
    }
    log(logfunction, options={}) {
        return this.pipe(ParallelStream.log(logfunction, options));
    }

    static map(mapfunction, options={}) {
        /*
        Transform input data to output data like `Array.prototype.map()`
        options { async }   True if asynchronous function of form f(obj, cb)
        */
        return new ParallelStream(Object.assign({
            parallel(o, encoding, cb) {
                let p = mapfunction(o, options.async ? cb : undefined);
                if (p instanceof Promise) {
                    console.assert(!options.async, "Shouldnt be doing promises and async")
                    p.then((data) => cb(null, data))
                        .catch((err) => cb(err));
                } else {
                    if (!options.async) {   // If options.async then assume mapfunction() called cb above
                        cb(null, p);
                    }
                }
            },
            name: "map"
        }, options));
    }
    map(mapfunction, options={}) {
        return this.pipe(ParallelStream.map(mapfunction, options));
    }

    static flatten(options={}) {
        /*
        input stream - of arrays or of streams
        output stream - expand arrays into a single stream

        Flatten a stream of arrays into a stream of items in those arrays,
        useful for example where a previous map call returns a list, each element of which requires independent processing.

        TODO could add options as to whether should handle single objs as well as arrays and whether to ignore undefined
         */
        // Usage example  writable.map(m => m*2, {name: "foo" }
        let psOut = new ParallelStream({
            name: options.name+" Out",
            //parallel is not defined, uses default which is pass-through
        });
        let psIn = new ParallelStream({
            name: options.name+" In",
            paralleloptions: {limit: 10}, // So that we'll count the parallel out calls and decrement on cb - keep this small, the downstream should be limiting buffering, if its large its easy to exceed number of open files allowed
            parallel(oo, encoding, cb) {
                //TODO handle Array & Obj
                if (Array.isArray(oo)) {
                    oo.forEach(o => psOut.push(o));
                    cb(null);
                } else if (oo instanceof stream.Readable) { //Includes Transform and Parallel streams
                    oo.pipe(psOut, {end: false});
                    oo.on('end', function () { cb(); });   // This cb will decrement the parallel count
                } else if ((typeof oo) !== "undefined") {   // Just push singletons
                    psOut.push(oo);
                    cb(null);
                }
            },
            flush(cb) {
                // This will be called after a) the psIn.end is called from upstream (all streams passed) *and* all oo.pipe's have also signalled end (counting down psIn.paralleloptions.count)
                this.debug("All streams should have completed");
                psOut.end(); // Tell psOut.end as we've explicitly stopped oo.end from causing it
                cb();
            },
        });
        psIn.out = psOut; // allows .out on a pipe to get the downstream
        return psIn; // Allows foo.pipe(PS.flatten()).out.log(...)
    }
    flatten(options={}) { return this.pipe(ParallelStream.flatten(options)).out; }

    static filter(filterfunction, options={}) {
        /*
            filterfunction(data) => boolean  Filter function that returns true for items to output

            input stream: objects
            output stream: objects where f(data) returns true
            Usage example: `parallelstream.filter(m=>m>1 && m<4)`

         */
        let ps = new ParallelStream(Object.assign({
            parallel(o, encoding, cb) {
                this.countIn++;
                if (filterfunction(o)) {
                    this.push(o);
                    this.countOut++;
                }
                cb();
            },
            flush(cb) { // Note this is called as the cb in _final() so paralell threads have all finished
                this.debug("Filter passed %d of %d", this.countOut, this.countIn);
                cb()
            },
            name: "filter"
        }, options));
        ps.countIn = 0;
        ps.countOut = 0;
        return ps;   // Note this is upstream
    }
    filter(filterfunction, options={}) { return this.pipe(ParallelStream.filter(filterfunction, options)); }

    static slice(begin, end, options={}) {
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
        return ps;
    }
    slice(begin, end, options={}) { return this.pipe(ParallelStream.slice(begin, end, options)); }

    static fork(...args) { //TODO need static version of this
        /*
            Fork a stream into multiple streams,
            args    each cb(parallelstream)
            last arg can be {} for options
            returns     last stream for chaining.

            Usage of fork is slightly different
            parallelstream.fork(s=>s.log(m=>m).reduce()).nextstream

            Warning all streams need to properly end, e.g. with .reduce() or pushback on one fork could effect all of them
          */
        let options = (typeof args[args.length-1] === "object") ? args.pop() : {};
        const defaultoptions = {
            name: "fork",
        }
        let ws = new ParallelStream(Object.assign({
            objectMode: true,
            parallel(o, encoding, cb) {
                if (typeof encoding === 'function') {
                    cb = encoding;
                    encoding = null;
                } // Allow missing encoding
                try {
                    let firstpushback = this.streams.map(s => s.write(o) ? false : s).find(s => !!s); // Writes to all streams, catches first that has pushback
                    this.push(o); // Send on main channel
                    if (firstpushback) {
                        this.debug("Pushback from %s", firstpushback.name);
                        firstpushback.once("drain", cb); // Just wait on first pushback to be ready, should be ok as if 2nd hasn't cleared it will pushback on next write
                        // Pushback on main stream should be automatic
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
                cb(); // Should generate end on main stream
            }
        },Object.assign(defaultoptions, options)));

        ws.streams = args.map(f => {
            let s = new ParallelStream(Object.assign(defaultoptions, options));
            f(s);
            return s;
        });
        return ws;  // Main stream for chaining
    }
    fork(...args) { return this.pipe(ParallelStream.fork(...args)); }

    static uniq(uniqfunction, options={}) {
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
        return ps;
    }
    uniq(uniqfunction, options={}) { return this.pipe(ParallelStream.uniq(uniqfunction, options)); }

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
                        if (!this.silentwait) {
                            through.debug("Pushing back on array, %d items left", ediblearr.length);
                        }
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
    static reduce(reducefunction, initialvalue, finalcb, options={}) {
        /*
            reducefunction(acc,d,i) acc = result so far, d = this item, i = index (starting 0), returns new acc
            initialvalue            value to set acc to for start
            finalcb(acc)            Called with final value of acc

            Note - if initialvalue is undefined, the first item in the stream will be the initial acc,
            and index will start at 1 for the first invocation of reducefunction which will be called with the second element.
         */
        if (typeof finalcb === "object") { options = finalcb; finalcb = undefined; }
        if (typeof initialvalue === "object") { options = initialvalue; initialvalue = undefined; }
        if (typeof reducefunction === "object") { options = reducefunction; reducefunction = undefined; }
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
            flush(cb) { // Note called in _final() after parallel threads (if present) have closed
                if (finalcb) finalcb.call(this, this.acc);
                cb();
            },
        }, options));
        ps.i = 0;
        ps.acc = initialvalue;
        // Init will be run by Parallel constructor
        return ps;
    }
    reduce(reducefunction, initialvalue, finalcb, options={}) {
        return this.pipe(ParallelStream.reduce(reducefunction, initialvalue, finalcb, options));
    }

}
exports = module.exports = ParallelStream;
