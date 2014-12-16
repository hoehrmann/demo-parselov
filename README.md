This repository contains samples that demonstate parts of a formal
language parsing system. There is a parser generator that takes a
formal grammar and generates a data file, and there is a sample
simulator that takes such a data file and a user-supplied document
and emits information about the syntactic structure of the document
according to the formal grammar. The system has an unusual design
and unusual characteristics:

* **Any context-free grammar can be used**. Ambiguity, left recursion,
right recursion, infinite look-ahead, cycles in production rules,
productions that match the empty string, Unicode, the system is not
troubled by any of these. Of course, if you need e.g. ambiguities
resolved, you have to implement that yourself as post-processing step
(parsers report all possible parse trees in compact form).
* **No human input is needed**. The system only needs a grammar that
can typically be copied from data format specifications; programs that
parse documents can be grammar-agnostic and generic. The system does
not generate programming language source code files where you have to
fill in gaps. You also do not have to modify the grammar to accomodate
ambiguity resolution or other algorithms.
* **Data-driven parsing**. Grammars are transformed into tabluar data
encoded in simple JSON documents amenable to machine processing. The
data files can be shared, re-used, analysed, transformed, compiled,
combined, and more, in a portable manner.
* **Linear parsing time and memory use**. Parsing time and memory use
are O(n) in the size of input documents and independent of the grammar.
For large input documents it is trivial to make a parser that uses
O(1) main memory and writes intermediate results to disk. One caveat:
for recursive grammars, parser output requires post-processing with
possibly non-linear complexity for some applications.
* **Credible performance**. It's not just linear, the constants are very
small aswell. An optimised parser will do nothing but simple arithmetic,
table lookups, and memory writes to store results, and should not do
much worse than typical regex engines. Note that parsing is branch-free
except for bound iterations, and beyond loading the statically prepared
parsing data there are no startup or other initialisation costs.
* **Security and standards compliance**. Parser construction does not
depend on human input and is thus not subject to human error. The data
tables describe finite state machines that can be exhaustively
simulated or analysed verifying that there are no chances for memory
corruption or other problems in dependant code for all inputs. When
the input grammar comes from a formal standard, there is no chance to
miss edge cases ensuring compliance.
* **Robustness and versatility**. The parsing system is part of a
divide-and-conquer strategy to parsing. A basic parser based on it
just solves part of the problem and higher level applications can and
have to perform additional work. That enables and encourages a coding
style amenable to change.

The typical use of the generated data files is from a parser that makes
two passes over an input document and then describes all possible parse
trees as a series of edge sets of a larger parse graph. The following
example illustrates this.

## Grammar-agnostic example parser

The following code is a complete and runnable NodeJS application that
reads a generated parsing data file, as they are included in this
repository, and a document, analyses the syntactic structure of the
document, and then generates a GraphViz-compatible `.dot` file of the
parse graph (for simple grammars or simple inputs, this is equivalent
to a linearised representation of the "parse tree" of the document
with respect to the relevant grammar).

```js
var fs = require('fs');
var zlib = require('zlib');
var util = require('util');

var input = fs.readFileSync(process.argv[3], {
  "encoding": "utf-8"
});

zlib.gunzip(fs.readFileSync(process.argv[2]), function(err, buf) {

  var g = JSON.parse(buf);
  
  ///////////////////////////////////////////////////////////////////
  // Typical grammars do not distinguish between all characters in
  // their alphabet, or the alphabet of the input to be parsed, like
  // all of Unicode. So in order to save space in the transition
  // tables, input symbol are mapped into a smaller set of symbols.
  ///////////////////////////////////////////////////////////////////
  var s = [].map.call(input, function(ch) {
    return g.input_to_symbol[ ch.charCodeAt(0) ]
  });

  ///////////////////////////////////////////////////////////////////
  // The mapped input symbols are then fed to a deterministic finite
  // state automaton. The sequence of states is stored for later use.
  // The initial state of the automaton is always `1` by convention.
  ///////////////////////////////////////////////////////////////////
  var fstate = 1;
  var forwards = [fstate].concat(s.map(function(i) {
    return fstate = g.states[fstate].transitions[i];
  }));
  
  ///////////////////////////////////////////////////////////////////
  // An input string does not necessarily match what the parser is
  // expecting. When the whole input is read, and the automaton is
  // not in an accepting state, then either there is an error in the
  // input, or the input is incomplete. The converse does not necess-
  // arily hold. For recursive grammars the automaton might be in an
  // accepting state even though the input does not match it.
  ///////////////////////////////////////////////////////////////////
  if (!g.states[fstate].is_accepting) {
    // ...
  }

  ///////////////////////////////////////////////////////////////////
  // The mapped input symbols are then fed to another determinisitic
  // finite automaton that parses the string again in reverse order,
  // The data stores for each accepting state a suitable start state.
  ///////////////////////////////////////////////////////////////////
  var bstate = g.states[fstate].backward_start;
  var backwards = s.reverse().map(function(i) {
    return bstate = g.states[bstate].transitions[i];
  });

  ///////////////////////////////////////////////////////////////////
  // The states of the automata correspond to graph vertices, and
  // taking the states from the forward and backward parses together,
  // the intersections of these sets can be computed for later use.
  ///////////////////////////////////////////////////////////////////
  var intersections = backwards.reverse().map(function(bck, ix) {
    return g.states[ forwards[ix] ].intersections[bck] || 0;
  });

  ///////////////////////////////////////////////////////////////////
  // Since computing the intersections takes into account parse data
  // from both ends of the input, an intersection together with the
  // corresponding input symbol is sufficient to identify the paths
  // taken through the graph at the input symbol's position. The
  // result is a set of edges which are computed in this last step.
  ///////////////////////////////////////////////////////////////////
  s.reverse();
  var edges = intersections.map(function(ins, ix) {
    return g.intersections[ins][ s[ix] ];
  }).concat([ g.states[fstate].terminal_edges ]);

  ///////////////////////////////////////////////////////////////////
  // The `edges` list is just a list of integers, each identifying a
  // set of edges. This is useful for post-processing operations, but
  // typical applications will need to resolve them to build a graph
  // for traversal. As an example, this function will print out the
  // whole parse graph as a GraphViz `dot` file that can be rendered.
  ///////////////////////////////////////////////////////////////////
  write_edges_in_graphviz_dot_format(g, edges);
});

function write_edges_in_graphviz_dot_format(g, edges) {

  ///////////////////////////////////////////////////////////////////
  // An edge consists of two vertices and every vertex can have some
  // properties. Among them are a type and a label. Important types
  // include "start" and "final" vertices. They signify the beginning
  // and end of named captures, and pairs of them correspond to non-
  // terminal symbols in a grammar. This function combines type and
  // label (the name of the non-terminal) into a vertex label.
  ///////////////////////////////////////////////////////////////////
  var print_label = function(offset, v) {
    process.stdout.write(util.format('"%s,%s"[label="%s %s"];\n',
      offset,
      v,
      g.vertices[v].type || "",
      g.vertices[v].text || v
    ));
  };

  process.stdout.write("digraph {\n");

  edges.forEach(function(id, ix) {
    /////////////////////////////////////////////////////////////////
    // There are two kinds of edges associated with edge identifiers.
    // "Null" edges represent transitions that do not consume input
    // symbols. They are needed to support nesting of non-terminals,
    // non-terminals that match the empty string, among other things.
    /////////////////////////////////////////////////////////////////
    g.null_edges[id].forEach(function(e) {
      process.stdout.write(util.format('"%s,%s" -> "%s,%s";\n',
        ix, e[0], ix, e[1]));
      print_label(ix, e[0]);
      print_label(ix, e[1]);
    });
    
    /////////////////////////////////////////////////////////////////
    // "Char" edges represent transitions that go outside of a set of
    // edges (and into the next) because an input symbol has to be
    // read to continue on their path. In other words, they are what
    // connects the individual edge sets to one another.
    /////////////////////////////////////////////////////////////////
    g.char_edges[id].forEach(function(e) {
      process.stdout.write(util.format('"%s,%s" -> "%s,%s";\n',
        ix, e[0], ix + 1, e[1]));
      print_label(ix, e[0]);
      print_label(ix + 1, e[1]);
    });
  });

  ///////////////////////////////////////////////////////////////////
  // If there are cycles in the parse graph at the first or the last
  // position, it may  be necessary to know which of the vertices
  // stands for the start symbol of the grammar. They are avaiable:
  ///////////////////////////////////////////////////////////////////
  var start_vertex = g.start_vertex;
  var final_vertex = g.final_vertex;
  
  process.stdout.write("}\n");
}
```

### Running the demo script

In order to run this demo, you can use something like the following.
Note that you need the GraphViz `dot` utility and NodeJS in addition
to `git`.

```
% git ...
% cd ...
% node demo-parselov.js rfc4627.JSON-text.json.gz ex.json > ex.dot
% dot -Tsvg -Grankdir=tb ex.dot > ex.svg
```

The `ex.json` file contains just the two characters `[]` and it might
be useful to take a look at the [RFC 4627 JSON grammar]
(https://tools.ietf.org/html/rfc4627#section-2) to understand the
result. It should look like this:

```
  +-------------------+     +-------------------+
0 |  start JSON-text  |  +->|  start end-array  | 1
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
0 |    start array    |  |  |     start ws      | 1
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
0 | start begin-array |  |  |     final ws      | 1
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
0 |     start ws      |  |  |     start ws      | 2
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
0 |     final ws      |  |  |     final ws      | 2
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
1 |     start ws      |  |  |  final end-array  | 2
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
1 |     final ws      |  |  |    final array    | 2
  +-------------------+  |  +-------------------+
            v            |            v
  +-------------------+  |  +-------------------+
1 | final begin-array |--+  |  final JSON-text  | 2
  +-------------------+     +-------------------+

```

The numbers next to the nodes indicate the offset into the list of
edges which correspond to the offset into the input data except for
terminal edges associated with the accepting state at the end of the
input. The `ws` nodes in the graph are there because the RFC 4627
grammar allows `ws` nodes to match the empty string, and since they
are mandatory, they appear in the graph even though there is no
white space in the input document. Applications not interested in the
nodes, or other uninteresting nodes like `begin-array`, can remove
them from the edge sets making parse graphs considerably smaller.

## Higher-level parser

The parsing process shown in the previous section can be thought of
as a pre-processing step that makes virtually all decisions that can
be made by a finite state automaton for a higher-level parser. Some
decisions still have to be made, for sufficiently complex grammars,
to determine whether the input actually matches the grammar, namely
whether there is a path through the parse graph that balances all
`start` points with their corresponding `end` points. Any such path
represents a valid parse tree for the input with respect to the
grammar the static parsing data is based on.

Finding such a path is a simple matter of traversing the graph from
a `start_vertex` to a `final_vertex`. The difficulty is in choosing
vertices whenever a given vertex has multiple successors. Picking a
wrong one wastes computing resources, and parsing algorithms differ
in how they avoid wasting resources. The pre-processing step in the
previous section trades high static memory use for convenience and
speed. It generally leaves very few wrong vertices to pick. As an
example, this demo includes the static data for RFC 4627 `JSON-text`.
In over 90% of the edges therein, all vertices have only a single
successor, and since the grammar is ambiguous, some vertices with
multiple successors actually represent genuine parsing alternatives.

The code below implements a simple generic backtracking traversal
through the parse graph and going through the tree, the parsers will
generate a simple JSON-based representation of the parse tree. It
processes edges from root of the graph to the bottom. Since the list
of edges is built the other way around, it could also start at the
bottom, in which case this code could run alongside building the
list of edges. It is important to understand that a vertex in a set
of edges corresponds to just a couple of instructions that are known
independently of the input; they can easily be compiled to a series
of machine instructions. Also note that this is just a demonstration
of what could be done after the pre-processing step using the static
data files. It is not considered part of what is discussed at the
beginning of this document.

```js
function generate_json_formatted_parse_tree(g, edges) {

  var parsers = [{
    output: "",
    offset: 0,
    vertex: g.start_vertex,
    stack: []
  }];

  ///////////////////////////////////////////////////////////////////
  // To recap, the result of the initial parse is a list of edge sets
  // each of which contains two different kinds of sets of edges. The
  // vertices encoded therein can have multiple successors. They come
  // from ambiguity and recursion in the input grammar. In order to
  // exhaustively search for a parse tree within the parse graph, it
  // may be necessary to explore all alternative successors of a ver-
  // tex. So whenever alternatives are encountered, they are recorded
  // in the `parsers` array, and the following algorithm contines un-
  // til either a parse tree has been found or until all alternatives
  // are exhausted. So the `while` loop takes care of the latter.
  ///////////////////////////////////////////////////////////////////
  while (parsers.length) {
    var p = parsers[0];

    if (g.vertices[p.vertex].type == "start") {
      ///////////////////////////////////////////////////////////////
      // Finding a parse tree within a parse graph requires matching
      // all starting points of non-terminal symbols to corresponding
      // end points so boundaries of a match are properly balanced.
      // When a starting point is found, it is pushed on to a stack.
      ///////////////////////////////////////////////////////////////
      p.stack.push({"vertex": p.vertex, "offset": p.offset});

      var indent = p.stack.map(function(){ return '  '; }).join("");

      p.output += "\n" + indent;
      p.output += '[' + JSON.stringify(g.vertices[p.vertex].text)
        .replace(/,/g, '\\u002c') + ', [';
    }
    
    if (g.vertices[p.vertex].type == "final") {
      ///////////////////////////////////////////////////////////////
      // When there is an opportunity to close the match that is on
      // the top of the stack, i.e., when a `final` vertex is found
      // on the path that is currently being explored, the vertex can
      // be compared to the stack's top element, and if they match,
      // we can move on to a successor vertex. On the other hand, if
      // the stack is empty, the code has taken a wrong turn.
      ///////////////////////////////////////////////////////////////
      if (p.stack.length == 0) {
        parsers.shift();
        continue;
      }
      
      var top = p.stack.pop();

      ///////////////////////////////////////////////////////////////
      // The `start` vertices know which `final` vertex they match
      // with, and if the top of the stack is not it, then the whole
      // parser is dropped, and the loop will try an alternative that
      // has been recorded earlier, if any.
      ///////////////////////////////////////////////////////////////
      if (p.vertex != g.vertices[top.vertex]["with"]) {
        parsers.shift();
        continue;
      }

      p.output += '], ' + top.offset + ', ' + p.offset + '],';
    }
    
    /////////////////////////////////////////////////////////////////
    // For a successfull match of the whole input, there are three 
    // conditions to be met: the parser must have reached the end of
    // the list of edges, which corresponds to the end of the input;
    // there must not be open matches left on the stack, and the ver-
    // at the end has to be the final vertex of the whole graph. It
    // is possible that there is still a loop around the final vertex
    // matching the empty string, but we ignore them here.
    /////////////////////////////////////////////////////////////////
    if (g.final_vertex == p.vertex) {
      if (p.offset + 1 >= edges.length)
        if (p.stack.length == 0)
          return p.output.replace(/,\]/g, ']').replace(/,$/, '');
    }
    
    /////////////////////////////////////////////////////////////////
    // Without a match and without a parsing failure, the path under
    // consideration can be explored further. For that the successors
    // of the current vertex have to be retrieved from static data.
    /////////////////////////////////////////////////////////////////
    var cs = g.char_edges[ edges[p.offset] ].filter(function(e) {
      return e && e[0] == p.vertex;
    }).map(function(e) {
      return { successor: e[1], type: "char" };
    });

    var ns = g.null_edges[ edges[p.offset] ].filter(function(e) {
      return e && e[0] == p.vertex;
    }).map(function(e) {
      return { successor: e[1], type: "null" };
    });
    
    var successors = ns.concat(cs);
    
    /////////////////////////////////////////////////////////////////
    // Vertices can have an associated `sort_key` to guide the choice
    // among alternative successors. A common disambiguation strategy
    // is to pick the "first", "left-most" alternative, in which case
    // the `sort_key` corresponds the position of grammar constructs
    // in the grammar the parsing data is based on. There are other,
    // possibly more complex, strategies that can be used instead.
    /////////////////////////////////////////////////////////////////
    successors.sort(function(a, b) {
      return (g.vertices[a.successor].sort_key || 0) -
             (g.vertices[b.successor].sort_key || 0);
    });
    
    /////////////////////////////////////////////////////////////////
    // It is possible that a vertex has no successors at this point,
    // even if there are no errors in the parsing data. In such cases
    // this parser has failed to match and alternatives are explored.
    /////////////////////////////////////////////////////////////////
    if (successors.length < 1) {
      parsers.shift();
      continue;
    }

    /////////////////////////////////////////////////////////////////
    // Sorting based on the `sort_key` leaves the best successor at
    // the first position. The current parser will continue with it.
    /////////////////////////////////////////////////////////////////
    var chosen = successors.shift();

    /////////////////////////////////////////////////////////////////
    // All other successors, if there are any, are turned into start
    // positions for additional parsers, that may be used instead of
    // the current one in case it ultimately fails to match.
    /////////////////////////////////////////////////////////////////
    successors.forEach(function(s) {
      parsers.push({
        output: p.output,
        offset: s.type == "char" ? p.offset + 1 : p.offset,
        vertex: s.successor,
        stack: p.stack.slice()
      });
    });

    /////////////////////////////////////////////////////////////////
    // Finally, if the successor vertex is taken from `char_edges`,
    // meaning an input symbol has been consumed to reach it, the
    // parser can move on to the next edge and process the successor.
    /////////////////////////////////////////////////////////////////
    if (chosen.type == "char") {
      p.offset += 1;
    }

    p.vertex = chosen.successor;
  }
}
```

Running this code with the RFC 4627 data file and `{"a\ffe":[]}` as
input, the result is the following JSON document. You can run this
yourself using the `-json` switch, something along the lines of:

```
% git ...
% cd ...
% node demo-parselov.js example.json.gz example.data -json
```

```js
["JSON-text", [
  ["object", [
    ["begin-object", [
      ["ws", [], 0, 0],
      ["ws", [], 1, 1]], 0, 1],
    ["member", [
      ["string", [
        ["quotation-mark", [], 1, 2],
        ["char", [
          ["unescaped", [], 2, 3]], 2, 3],
        ["char", [
          ["escape", [], 3, 4]], 3, 5],
        ["char", [
          ["unescaped", [], 5, 6]], 5, 6],
        ["char", [
          ["unescaped", [], 6, 7]], 6, 7],
        ["quotation-mark", [], 7, 8]], 1, 8],
      ["name-separator", [
        ["ws", [], 8, 8],
        ["ws", [], 9, 9]], 8, 9],
      ["value", [
        ["array", [
          ["begin-array", [
            ["ws", [], 9, 9],
            ["ws", [], 10, 10]], 9, 10],
          ["end-array", [
            ["ws", [], 10, 10],
            ["ws", [], 11, 11]], 10, 11]], 9, 11]], 9, 11]], 1, 11],
    ["end-object", [
      ["ws", [], 11, 11],
      ["ws", [], 12, 12]], 11, 12]], 0, 12]], 0, 12]
```

Using the RFC 3986 data file and the string `example://0.0.0.0:23#x` gives:

```js
["URI", [
  ["scheme", [
    ["ALPHA", [], 0, 1],
    ["ALPHA", [], 1, 2],
    ["ALPHA", [], 2, 3],
    ["ALPHA", [], 3, 4],
    ["ALPHA", [], 4, 5],
    ["ALPHA", [], 5, 6],
    ["ALPHA", [], 6, 7]], 0, 7],
  ["hier-part", [
    ["authority", [
      ["host", [
        ["IPv4address", [
          ["dec-octet", [
            ["DIGIT", [], 10, 11]], 10, 11],
          ["dec-octet", [
            ["DIGIT", [], 12, 13]], 12, 13],
          ["dec-octet", [
            ["DIGIT", [], 14, 15]], 14, 15],
          ["dec-octet", [
            ["DIGIT", [], 16, 17]], 16, 17]], 10, 17]], 10, 17],
      ["port", [
        ["DIGIT", [], 18, 19],
        ["DIGIT", [], 19, 20]], 18, 20]], 10, 20],
    ["path-abempty", [], 20, 20]], 8, 20],
  ["fragment", [
    ["pchar", [
      ["unreserved", [
        ["ALPHA", [], 21, 22]], 21, 22]], 21, 22]], 21, 22]], 0, 22]
```
