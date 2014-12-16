var fs = require('fs');
var zlib = require('zlib');
var util = require('util');

var as_json = process.argv[4] == "-json";

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
    return g.input_to_symbol[ ch.charCodeAt(0) ] || 0
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
    process.stderr.write("failed around " + forwards.indexOf('0'));
    return;
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

  if (as_json) {
    var tree = generate_json_formatted_parse_tree(g, edges);
    process.stdout.write(tree + "\n");
    return;
  }
  
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
