# parallel-streams - Adding parallelism and array functions to streams.

Adds the functionality available to arrays to streams and allows parallelism.

There are two complementary aspects to the parallel-streams module.

The ParallelStream class supports a set of options to allow control of
processing each item in the stream in parallel. 
This is particularly useful when doing disk or network IO of variable length so
that slower items don't hold up faster ones when order is unimportant.

A set of utility functions allow using much of the functionality of Arrays on streams.
It uses similar syntax and semantics to hopefully make code more readable. 

## Examples
(also in examples.js)
```
const ParallelStream = require('parallel-streams.js');

ParallelStream.from([0,1,2,3], {name: "Munching"})  // Create a stream called "Munching" that will output the items 0,1,2,3
    .log(m=>[m], {name:"Stream 0..3"}); // 0 1 2 3  Log each item in the stream before passing it on.

// Now add a map function that squares each item in the stream
ParallelStream.from([0,1,2,3]) .map(m=>m**2) .log(m=>[m], {name:"Stream 0,1,4,9"})

// If our stream has arrays, then you can flatten them into a stream of their elements
ParallelStream.from([[0,"a"],[1,"b"]]) .log(m=>[m], {name:"Stream [0,a],[1,b]"}) .flatten() .log(m=>[m], {name:"Stream 0,a,1,b"})

// And you can filter
ParallelStream.from([0,1,2,3,4]) .filter(m=>m>1 && m<4) .log(m=>[m], {name:"Stream filter 2,3"})

// Or select uniq items
ParallelStream.from([0,1,2,2,1]) .uniq() .log(m=>[m], {name:"Stream uniq 0,1,2"})

// Or slice out a range
ParallelStream.from([0,1,2,3,4]) .slice(2,4) .log(m=>[m], {name:"Stream slice 2,3"})

// A little more complexity allows forking a stream and running two or more sets of processing on it.
let ss = ParallelStream.from([0,1]) .fork(2).streams;
ss[0].log(m=>[m], {name: "ForkA 0,1"});
ss[0].log(m=>[m], {name: "ForkB 0,1"});


// Reduce works, but note that you have to use the 'function' syntax instead of (a,b)=>(a+b) if you want to use "this" for debugging.
// The result here should be 110 as 0 is used as the initial value
ParallelStream.from([10,20,30,40]) .reduce(function(acc,d,i) { return (acc + i + d+1) }, 0, function(res) {this.debug("SUM=", res)}, { name: "Sum=110" });
// The result here should be 110 as it runs reduce 3 times, with the 10 is used as initial value.
ParallelStream.from([10,20,30,40]) .reduce(function(acc,d,i) { return (acc + i + d+1) }, undefined, function(res) {this.debug("SUM=", res)}, { name: "Sum=109" });
// Reduce with no arguments is useful at the end of a chain of streams to avoid the last stream pushing back when it can't write.
ParallelStream.from([10,20,30,40]) .reduce();
```

## API
####ParallelStream(options) - Create a new Parallel Stream
```
options = {
    name            Set to a name to use in debugging (this.debug will be active on parallel-streams:<name>
    paralleloptions {
        limit: maximum number of threads to run in parallel
        retryms:    How long to wait before retrying if thread count exceeded,
        silentwait: Set to true to remove debugging when waiting
        },
    parallel(data, encoding, cb),   Function like transform(), including how to use push() and cb(err, data)
    init()          Called at initialization 
    //Inherited from TransformStream:
    flush(cb)   runs at completion before the stream is closed, should call cb when complete.
    highWaterMark   int Sets how many data items can be queued up
}
```
The main differences with TransformStream are:

* do not pass transform() unless you intentionally are replacing the parallel behavior,
* objectMode is set to true by default.
    
Other functionality of TransformStream should work, but might not have been tested.

### Functions on Parallel Stream
Each of the following functions (unless stated) is intended to be chained, 
i.e. the call returns a stream which can itself be chained. 

Each function takes options which are passed to the ParallelStreams constructor.

Each function defaults to having a name which is the name of the function, 
but can be overwritten by setting the option `name: "...."` 

#### ParallelStream.prototype.log(f(data)=>string, options={})

Log output using debug("parallel-streams:<name>"), 
`f(data)` should return an array suitable for passing to debug(), 
i.e. the first parameter can contain formatting like %s %d %o (see npm:debug for details)

Passes input to the next stream unchanged (unless f(input) has side-effects)

e.g. .log(data => ["Handling %o", data])

#### ParallelStream.prototype.map(f(data)=>obj, options={})

Transform input data to output data like `Array.prototype.map()`

e.g. `.map(data => inp**2)`

#### ParallelStream.prototype.flatten(options={})

```
input: stream of arrays of x
output: stream of x
```
Flatten a stream of arrays into a stream of items in those arrays, 
useful for example where a previous map call returns a list, each element of which requires independent processing.

TODO could add options as to whether should handle single objs as well as arrays and whether to ignore undefined

#### ParallelStream.prototype.filter(f(data) => boolean, options={})
```
f(data) => boolean  Filter function that returns true for items to output

input stream: objects
output stream: objects where f(data) returns true
```
Usage example: `parallelstream.filter(m=>m>1 && m<4)`

#### ParallelStream.prototype.slice(begin, end, options={})
```
begin:  first item to pass,
end:    one after last item
input   stream: objects
output  stream: objects[begin...end-1]
```

#### ParallelStream.prototype.fork(nstreams, options={})
Fork a stream into multiple streams,
```
nstreams    Number of streams to fork into
returns     Array of Parallel streams.
```
Usage of fork is slightly different
```
let ss =  parallelstream.fork(2).streams;
ss[0].log ...; ss[1].filter.... etc
```
Warning all streams need to properly end e.g. with .reduce() or pushback on one fork could effect all of them.

#### ParallelStream.prototype.uniq(f(data)=>string, options={}) {
Uniq allows cleaning a stream of duplicates, an optional function allows generating an id to use for duplicate checking. 
```
f(data) => string: optional function to return a string that can be used to compare uniqueness (for example an id)
options { uniq: optional array to use for checking uniqueness (allows testing against existing list)
```
#### static ParallelStream.from(arr, options={})
Create a new ParallelStream from an array, usually this will be the start of any pipeline of streams. 
```
arr Array of any kind of object
output: Elements of arr, in order.
```

#### ParallelStream.reduce(f(acc, data, index)=>acc, initialAcc, cb(data), options={})
Behaves like `Array.prototype.reduce()`
```
f(acc, data, index): acc = result so far, data = next item from stream, index = index in stream
initialAcc:    Initial value to acc
cb(data):       Function to call after the last item is processed.
```
Note, as for Array.prototype.reduce(), if no initialAcc is provided, then the first item in the stream
will be used as the initial value of acc, and the reduction function will get called for the first time 
using the index=1 and the second item from the stream.

Note that reduce() is the only one of the above functions (other than fork) that doesnt return a ParallelStream.
This makes it suitable for ending a chain of streams to avoid the last stream pushing back. Expect to see 
`.reduce()` At the end of most pipelines.




