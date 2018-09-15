/*
This file has some examples of using the array functions

TODO add examples of the concurrency functions.

 */

process.env.DEBUG="parallel-streams:*";  //Get debugging on all streams

const ParallelStream = require('./index.js');

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

