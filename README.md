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
      g.vertices[v].label || v
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

