/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.
  https://github.com/mishoo/UglifyJS2

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2012 (c) Mihai Bazon <mihai.bazon@gmail.com>

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

"use strict";

function Compressor(options, false_by_default) {
    if (!(this instanceof Compressor))
        return new Compressor(options, false_by_default);
    TreeTransformer.call(this, this.before, this.after);
    this.options = defaults(options, {
        sequences     : !false_by_default,
        properties    : !false_by_default,
        dead_code     : !false_by_default,
        drop_debugger : !false_by_default,
        unsafe        : false,
        unsafe_comps  : false,
        unsafe_proto  : false,
        conditionals  : !false_by_default,
        comparisons   : !false_by_default,
        evaluate      : !false_by_default,
        booleans      : !false_by_default,
        loops         : !false_by_default,
        unused        : !false_by_default,
        toplevel      : !!(options && options["top_retain"]),
        top_retain    : null,
        hoist_funs    : !false_by_default,
        keep_fargs    : true,
        keep_fnames   : false,
        hoist_vars    : false,
        if_return     : !false_by_default,
        join_vars     : !false_by_default,
        collapse_vars : !false_by_default,
        reduce_vars   : !false_by_default,
        cascade       : !false_by_default,
        side_effects  : !false_by_default,
        pure_getters  : false,
        pure_funcs    : null,
        negate_iife   : !false_by_default,
        screw_ie8     : true,
        drop_console  : false,
        angular       : false,
        warnings      : true,
        global_defs   : {},
        passes        : 1,
    }, true);
    var pure_funcs = this.options["pure_funcs"];
    if (typeof pure_funcs == "function") {
        this.pure_funcs = pure_funcs;
    } else {
        this.pure_funcs = pure_funcs ? function(node) {
            return pure_funcs.indexOf(node.expression.print_to_string()) < 0;
        } : return_true;
    }
    var top_retain = this.options["top_retain"];
    if (top_retain instanceof RegExp) {
        this.top_retain = function(def) {
            return top_retain.test(def.name);
        };
    } else if (typeof top_retain === "function") {
        this.top_retain = top_retain;
    } else if (top_retain) {
        if (typeof top_retain === "string") {
            top_retain = top_retain.split(/,/);
        }
        this.top_retain = function(def) {
            return top_retain.indexOf(def.name) >= 0;
        };
    }
    var sequences = this.options["sequences"];
    this.sequences_limit = sequences == 1 ? 200 : sequences | 0;
    this.warnings_produced = {};
};

Compressor.prototype = new TreeTransformer;
merge(Compressor.prototype, {
    option: function(key) { return this.options[key] },
    compress: function(node) {
        var passes = +this.options.passes || 1;
        for (var pass = 0; pass < passes && pass < 3; ++pass) {
            if (pass > 0 || this.option("reduce_vars"))
                node.reset_opt_flags(this, true);
            node = node.transform(this);
        }
        return node;
    },
    warn: function(text, props) {
        if (this.options.warnings) {
            // only emit unique warnings
            var message = string_template(text, props);
            if (!(message in this.warnings_produced)) {
                this.warnings_produced[message] = true;
                AST_Node.warn.apply(AST_Node, arguments);
            }
        }
    },
    clear_warnings: function() {
        this.warnings_produced = {};
    },
    before: function(node, descend, in_list) {
        if (node._squeezed) return node;
        var was_scope = false;
        if (node instanceof AST_Scope) {
            node = node.hoist_declarations(this);
            was_scope = true;
        }
        descend(node, this);
        node = node.optimize(this);
        if (was_scope && node instanceof AST_Scope) {
            node.drop_unused(this);
            descend(node, this);
        }
        node._squeezed = true;
        return node;
    }
});

(function(){

    function OPT(node, optimizer) {
        node.DEFMETHOD("optimize", function(compressor){
            var self = this;
            if (self._optimized) return self;
            if (compressor.has_directive("use asm")) return self;
            var opt = optimizer(self, compressor);
            opt._optimized = true;
            if (opt === self) return opt;
            return opt.transform(compressor);
        });
    };

    OPT(AST_Node, function(self, compressor){
        return self;
    });

    AST_Node.DEFMETHOD("equivalent_to", function(node){
        // XXX: this is a rather expensive way to test two node's equivalence:
        return this.print_to_string() == node.print_to_string();
    });

    AST_Node.DEFMETHOD("reset_opt_flags", function(compressor, rescan){
        var reduce_vars = rescan && compressor.option("reduce_vars");
        var unsafe = compressor.option("unsafe");
        var tw = new TreeWalker(function(node){
            if (reduce_vars) {
                if (node instanceof AST_Toplevel) node.globals.each(reset_def);
                if (node instanceof AST_Scope) node.variables.each(reset_def);
                if (node instanceof AST_SymbolRef) {
                    var d = node.definition();
                    d.references.push(node);
                    if (d.fixed && (d.orig.length > 1 || isModified(node, 0))) {
                        d.fixed = false;
                    }
                }
                if (node instanceof AST_Call && node.expression instanceof AST_Function) {
                    node.expression.argnames.forEach(function(arg, i) {
                        arg.definition().init = node.args[i] || make_node(AST_Undefined, node);
                    });
                }
            }
            if (!(node instanceof AST_Directive || node instanceof AST_Constant)) {
                node._squeezed = false;
                node._optimized = false;
            }
        });
        this.walk(tw);

        function reset_def(def) {
            def.fixed = true;
            def.references = [];
            def.should_replace = undefined;
            if (unsafe && def.init) {
                def.init._evaluated = undefined;
            }
        }

        function isModified(node, level) {
            var parent = tw.parent(level);
            if (isLHS(node, parent)
                || parent instanceof AST_Call && parent.expression === node) {
                return true;
            } else if (parent instanceof AST_PropAccess && parent.expression === node) {
                return isModified(parent, level + 1);
            }
        }
    });

    function make_node(ctor, orig, props) {
        if (!props) props = {};
        if (orig) {
            if (!props.start) props.start = orig.start;
            if (!props.end) props.end = orig.end;
        }
        return new ctor(props);
    };

    function make_node_from_constant(compressor, val, orig) {
        switch (typeof val) {
          case "string":
            return make_node(AST_String, orig, {
                value: val
            });
          case "number":
            if (isNaN(val)) {
                return make_node(AST_NaN, orig);
            }

            if ((1 / val) < 0) {
                return make_node(AST_UnaryPrefix, orig, {
                    operator: "-",
                    expression: make_node(AST_Number, orig, { value: -val })
                });
            }

            return make_node(AST_Number, orig, { value: val });
          case "boolean":
            return make_node(val ? AST_True : AST_False, orig).transform(compressor);
          case "undefined":
            return make_node(AST_Undefined, orig).transform(compressor);
          default:
            if (val === null) {
                return make_node(AST_Null, orig, { value: null });
            }
            if (val instanceof RegExp) {
                return make_node(AST_RegExp, orig, { value: val });
            }
            throw new Error(string_template("Can't handle constant of type: {type}", {
                type: typeof val
            }));
        }
    };

    // we shouldn't compress (1,func)(something) to
    // func(something) because that changes the meaning of
    // the func (becomes lexical instead of global).
    function maintain_this_binding(parent, orig, val) {
        if (parent instanceof AST_Call && parent.expression === orig) {
            if (val instanceof AST_PropAccess || val instanceof AST_SymbolRef && val.name === "eval") {
                return make_node(AST_Seq, orig, {
                    car: make_node(AST_Number, orig, {
                        value: 0
                    }),
                    cdr: val
                });
            }
        }
        return val;
    }

    function as_statement_array(thing) {
        if (thing === null) return [];
        if (thing instanceof AST_BlockStatement) return thing.body;
        if (thing instanceof AST_EmptyStatement) return [];
        if (thing instanceof AST_Statement) return [ thing ];
        throw new Error("Can't convert thing to statement array");
    };

    function is_empty(thing) {
        if (thing === null) return true;
        if (thing instanceof AST_EmptyStatement) return true;
        if (thing instanceof AST_BlockStatement) return thing.body.length == 0;
        return false;
    };

    function loop_body(x) {
        if (x instanceof AST_Switch) return x;
        if (x instanceof AST_For || x instanceof AST_ForIn || x instanceof AST_DWLoop) {
            return (x.body instanceof AST_BlockStatement ? x.body : x);
        }
        return x;
    };

    var readOnlyPrefix = makePredicate("! ~ + - void typeof");
    function statement_to_expression(stat) {
        if (stat.body instanceof AST_UnaryPrefix && readOnlyPrefix(stat.body.operator)) {
            return stat.body.expression;
        } else {
            return stat.body;
        }
    }

    function is_iife_call(node) {
        if (node instanceof AST_Call && !(node instanceof AST_New)) {
            return node.expression instanceof AST_Function || is_iife_call(node.expression);
        }
        return false;
    }

    function tighten_body(statements, compressor) {
        var CHANGED, max_iter = 10;
        do {
            CHANGED = false;
            if (compressor.option("angular")) {
                statements = process_for_angular(statements);
            }
            statements = eliminate_spurious_blocks(statements);
            if (compressor.option("dead_code")) {
                statements = eliminate_dead_code(statements, compressor);
            }
            if (compressor.option("if_return")) {
                statements = handle_if_return(statements, compressor);
            }
            if (compressor.sequences_limit > 0) {
                statements = sequencesize(statements, compressor);
            }
            if (compressor.option("join_vars")) {
                statements = join_consecutive_vars(statements, compressor);
            }
            if (compressor.option("collapse_vars")) {
                statements = collapse_single_use_vars(statements, compressor);
            }
        } while (CHANGED && max_iter-- > 0);

        return statements;

        function collapse_single_use_vars(statements, compressor) {
            // Iterate statements backwards looking for a statement with a var/const
            // declaration immediately preceding it. Grab the rightmost var definition
            // and if it has exactly one reference then attempt to replace its reference
            // in the statement with the var value and then erase the var definition.

            var self = compressor.self();
            var var_defs_removed = false;
            for (var stat_index = statements.length; --stat_index >= 0;) {
                var stat = statements[stat_index];
                if (stat instanceof AST_Definitions) continue;

                // Process child blocks of statement if present.
                [stat, stat.body, stat.alternative, stat.bcatch, stat.bfinally].forEach(function(node) {
                    node && node.body && collapse_single_use_vars(node.body, compressor);
                });

                // The variable definition must precede a statement.
                if (stat_index <= 0) break;
                var prev_stat_index = stat_index - 1;
                var prev_stat = statements[prev_stat_index];
                if (!(prev_stat instanceof AST_Definitions)) continue;
                var var_defs = prev_stat.definitions;
                if (var_defs == null) continue;

                var var_names_seen = {};
                var side_effects_encountered = false;
                var lvalues_encountered = false;
                var lvalues = {};

                // Scan variable definitions from right to left.
                for (var var_defs_index = var_defs.length; --var_defs_index >= 0;) {

                    // Obtain var declaration and var name with basic sanity check.
                    var var_decl = var_defs[var_defs_index];
                    if (var_decl.value == null) break;
                    var var_name = var_decl.name.name;
                    if (!var_name || !var_name.length) break;

                    // Bail if we've seen a var definition of same name before.
                    if (var_name in var_names_seen) break;
                    var_names_seen[var_name] = true;

                    // Only interested in cases with just one reference to the variable.
                    var def = self.find_variable && self.find_variable(var_name);
                    if (!def || !def.references || def.references.length !== 1 || var_name == "arguments") {
                        side_effects_encountered = true;
                        continue;
                    }
                    var ref = def.references[0];

                    // Don't replace ref if eval() or with statement in scope.
                    if (ref.scope.uses_eval || ref.scope.uses_with) break;

                    // Constant single use vars can be replaced in any scope.
                    if (var_decl.value.is_constant()) {
                        var ctt = new TreeTransformer(function(node) {
                            if (node === ref)
                                return replace_var(node, ctt.parent(), true);
                        });
                        stat.transform(ctt);
                        continue;
                    }

                    // Restrict var replacement to constants if side effects encountered.
                    if (side_effects_encountered |= lvalues_encountered) continue;

                    // Non-constant single use vars can only be replaced in same scope.
                    if (ref.scope !== self) {
                        side_effects_encountered |= var_decl.value.has_side_effects(compressor);
                        continue;
                    }

                    // Detect lvalues in var value.
                    var tw = new TreeWalker(function(node){
                        if (node instanceof AST_SymbolRef && is_lvalue(node, tw.parent())) {
                            lvalues[node.name] = lvalues_encountered = true;
                        }
                    });
                    var_decl.value.walk(tw);

                    // Replace the non-constant single use var in statement if side effect free.
                    var unwind = false;
                    var tt = new TreeTransformer(
                        function preorder(node) {
                            if (unwind) return node;
                            var parent = tt.parent();
                            if (node instanceof AST_Lambda
                                || node instanceof AST_Try
                                || node instanceof AST_With
                                || node instanceof AST_Case
                                || node instanceof AST_IterationStatement
                                || (parent instanceof AST_If          && node !== parent.condition)
                                || (parent instanceof AST_Conditional && node !== parent.condition)
                                || (parent instanceof AST_Binary
                                    && (parent.operator == "&&" || parent.operator == "||")
                                    && node === parent.right)
                                || (parent instanceof AST_Switch && node !== parent.expression)) {
                                return side_effects_encountered = unwind = true, node;
                            }
                        },
                        function postorder(node) {
                            if (unwind) return node;
                            if (node === ref)
                                return unwind = true, replace_var(node, tt.parent(), false);
                            if (side_effects_encountered |= node.has_side_effects(compressor))
                                return unwind = true, node;
                            if (lvalues_encountered && node instanceof AST_SymbolRef && node.name in lvalues) {
                                side_effects_encountered = true;
                                return unwind = true, node;
                            }
                        }
                    );
                    stat.transform(tt);
                }
            }

            // Remove extraneous empty statments in block after removing var definitions.
            // Leave at least one statement in `statements`.
            if (var_defs_removed) for (var i = statements.length; --i >= 0;) {
                if (statements.length > 1 && statements[i] instanceof AST_EmptyStatement)
                    statements.splice(i, 1);
            }

            return statements;

            function is_lvalue(node, parent) {
                return node instanceof AST_SymbolRef && (
                    (parent instanceof AST_Assign && node === parent.left)
                    || (parent instanceof AST_Unary && parent.expression === node
                        && (parent.operator == "++" || parent.operator == "--")));
            }
            function replace_var(node, parent, is_constant) {
                if (is_lvalue(node, parent)) return node;

                // Remove var definition and return its value to the TreeTransformer to replace.
                var value = maintain_this_binding(parent, node, var_decl.value);
                var_decl.value = null;

                var_defs.splice(var_defs_index, 1);
                if (var_defs.length === 0) {
                    statements[prev_stat_index] = make_node(AST_EmptyStatement, self);
                    var_defs_removed = true;
                }
                // Further optimize statement after substitution.
                stat.reset_opt_flags(compressor);

                compressor.warn("Replacing " + (is_constant ? "constant" : "variable") +
                    " " + var_name + " [{file}:{line},{col}]", node.start);
                CHANGED = true;
                return value;
            }
        }

        function process_for_angular(statements) {
            function has_inject(comment) {
                return /@ngInject/.test(comment.value);
            }
            function make_arguments_names_list(func) {
                return func.argnames.map(function(sym){
                    return make_node(AST_String, sym, { value: sym.name });
                });
            }
            function make_array(orig, elements) {
                return make_node(AST_Array, orig, { elements: elements });
            }
            function make_injector(func, name) {
                return make_node(AST_SimpleStatement, func, {
                    body: make_node(AST_Assign, func, {
                        operator: "=",
                        left: make_node(AST_Dot, name, {
                            expression: make_node(AST_SymbolRef, name, name),
                            property: "$inject"
                        }),
                        right: make_array(func, make_arguments_names_list(func))
                    })
                });
            }
            function check_expression(body) {
                if (body && body.args) {
                    // if this is a function call check all of arguments passed
                    body.args.forEach(function(argument, index, array) {
                        var comments = argument.start.comments_before;
                        // if the argument is function preceded by @ngInject
                        if (argument instanceof AST_Lambda && comments.length && has_inject(comments[0])) {
                            // replace the function with an array of names of its parameters and function at the end
                            array[index] = make_array(argument, make_arguments_names_list(argument).concat(argument));
                        }
                    });
                    // if this is chained call check previous one recursively
                    if (body.expression && body.expression.expression) {
                        check_expression(body.expression.expression);
                    }
                }
            }
            return statements.reduce(function(a, stat){
                a.push(stat);

                if (stat.body && stat.body.args) {
                    check_expression(stat.body);
                } else {
                    var token = stat.start;
                    var comments = token.comments_before;
                    if (comments && comments.length > 0) {
                        var last = comments.pop();
                        if (has_inject(last)) {
                            // case 1: defun
                            if (stat instanceof AST_Defun) {
                                a.push(make_injector(stat, stat.name));
                            }
                            else if (stat instanceof AST_Definitions) {
                                stat.definitions.forEach(function(def) {
                                    if (def.value && def.value instanceof AST_Lambda) {
                                        a.push(make_injector(def.value, def.name));
                                    }
                                });
                            }
                            else {
                                compressor.warn("Unknown statement marked with @ngInject [{file}:{line},{col}]", token);
                            }
                        }
                    }
                }

                return a;
            }, []);
        }

        function eliminate_spurious_blocks(statements) {
            var seen_dirs = [];
            return statements.reduce(function(a, stat){
                if (stat instanceof AST_BlockStatement) {
                    CHANGED = true;
                    a.push.apply(a, eliminate_spurious_blocks(stat.body));
                } else if (stat instanceof AST_EmptyStatement) {
                    CHANGED = true;
                } else if (stat instanceof AST_Directive) {
                    if (seen_dirs.indexOf(stat.value) < 0) {
                        a.push(stat);
                        seen_dirs.push(stat.value);
                    } else {
                        CHANGED = true;
                    }
                } else {
                    a.push(stat);
                }
                return a;
            }, []);
        };

        function handle_if_return(statements, compressor) {
            var self = compressor.self();
            var multiple_if_returns = has_multiple_if_returns(statements);
            var in_lambda = self instanceof AST_Lambda;
            var ret = []; // Optimized statements, build from tail to front
            loop: for (var i = statements.length; --i >= 0;) {
                var stat = statements[i];
                switch (true) {
                  case (in_lambda && stat instanceof AST_Return && !stat.value && ret.length == 0):
                    CHANGED = true;
                    // note, ret.length is probably always zero
                    // because we drop unreachable code before this
                    // step.  nevertheless, it's good to check.
                    continue loop;
                  case stat instanceof AST_If:
                    if (stat.body instanceof AST_Return) {
                        //---
                        // pretty silly case, but:
                        // if (foo()) return; return; ==> foo(); return;
                        if (((in_lambda && ret.length == 0)
                             || (ret[0] instanceof AST_Return && !ret[0].value))
                            && !stat.body.value && !stat.alternative) {
                            CHANGED = true;
                            var cond = make_node(AST_SimpleStatement, stat.condition, {
                                body: stat.condition
                            });
                            ret.unshift(cond);
                            continue loop;
                        }
                        //---
                        // if (foo()) return x; return y; ==> return foo() ? x : y;
                        if (ret[0] instanceof AST_Return && stat.body.value && ret[0].value && !stat.alternative) {
                            CHANGED = true;
                            stat = stat.clone();
                            stat.alternative = ret[0];
                            ret[0] = stat.transform(compressor);
                            continue loop;
                        }
                        //---
                        // if (foo()) return x; [ return ; ] ==> return foo() ? x : undefined;
                        if (multiple_if_returns && (ret.length == 0 || ret[0] instanceof AST_Return)
                            && stat.body.value && !stat.alternative && in_lambda) {
                            CHANGED = true;
                            stat = stat.clone();
                            stat.alternative = ret[0] || make_node(AST_Return, stat, {
                                value: make_node(AST_Undefined, stat)
                            });
                            ret[0] = stat.transform(compressor);
                            continue loop;
                        }
                        //---
                        // if (foo()) return; [ else x... ]; y... ==> if (!foo()) { x...; y... }
                        if (!stat.body.value && in_lambda) {
                            CHANGED = true;
                            stat = stat.clone();
                            stat.condition = stat.condition.negate(compressor);
                            var body = as_statement_array(stat.alternative).concat(ret);
                            var funs = extract_functions_from_statement_array(body);
                            stat.body = make_node(AST_BlockStatement, stat, {
                                body: body
                            });
                            stat.alternative = null;
                            ret = funs.concat([ stat.transform(compressor) ]);
                            continue loop;
                        }

                        //---
                        // if (a) return b; if (c) return d; e; ==> return a ? b : c ? d : void e;
                        //
                        // if sequences is not enabled, this can lead to an endless loop (issue #866).
                        // however, with sequences on this helps producing slightly better output for
                        // the example code.
                        if (compressor.option("sequences")
                            && i > 0 && statements[i - 1] instanceof AST_If && statements[i - 1].body instanceof AST_Return
                            && ret.length == 1 && in_lambda && ret[0] instanceof AST_SimpleStatement
                            && !stat.alternative) {
                            CHANGED = true;
                            ret.push(make_node(AST_Return, ret[0], {
                                value: make_node(AST_Undefined, ret[0])
                            }).transform(compressor));
                            ret.unshift(stat);
                            continue loop;
                        }
                    }

                    var ab = aborts(stat.body);
                    var lct = ab instanceof AST_LoopControl ? compressor.loopcontrol_target(ab.label) : null;
                    if (ab && ((ab instanceof AST_Return && !ab.value && in_lambda)
                               || (ab instanceof AST_Continue && self === loop_body(lct))
                               || (ab instanceof AST_Break && lct instanceof AST_BlockStatement && self === lct))) {
                        if (ab.label) {
                            remove(ab.label.thedef.references, ab);
                        }
                        CHANGED = true;
                        var body = as_statement_array(stat.body).slice(0, -1);
                        stat = stat.clone();
                        stat.condition = stat.condition.negate(compressor);
                        stat.body = make_node(AST_BlockStatement, stat, {
                            body: as_statement_array(stat.alternative).concat(ret)
                        });
                        stat.alternative = make_node(AST_BlockStatement, stat, {
                            body: body
                        });
                        ret = [ stat.transform(compressor) ];
                        continue loop;
                    }

                    var ab = aborts(stat.alternative);
                    var lct = ab instanceof AST_LoopControl ? compressor.loopcontrol_target(ab.label) : null;
                    if (ab && ((ab instanceof AST_Return && !ab.value && in_lambda)
                               || (ab instanceof AST_Continue && self === loop_body(lct))
                               || (ab instanceof AST_Break && lct instanceof AST_BlockStatement && self === lct))) {
                        if (ab.label) {
                            remove(ab.label.thedef.references, ab);
                        }
                        CHANGED = true;
                        stat = stat.clone();
                        stat.body = make_node(AST_BlockStatement, stat.body, {
                            body: as_statement_array(stat.body).concat(ret)
                        });
                        stat.alternative = make_node(AST_BlockStatement, stat.alternative, {
                            body: as_statement_array(stat.alternative).slice(0, -1)
                        });
                        ret = [ stat.transform(compressor) ];
                        continue loop;
                    }

                    ret.unshift(stat);
                    break;
                  default:
                    ret.unshift(stat);
                    break;
                }
            }
            return ret;

            function has_multiple_if_returns(statements) {
                var n = 0;
                for (var i = statements.length; --i >= 0;) {
                    var stat = statements[i];
                    if (stat instanceof AST_If && stat.body instanceof AST_Return) {
                        if (++n > 1) return true;
                    }
                }
                return false;
            }
        };

        function eliminate_dead_code(statements, compressor) {
            var has_quit = false;
            var orig = statements.length;
            var self = compressor.self();
            statements = statements.reduce(function(a, stat){
                if (has_quit) {
                    extract_declarations_from_unreachable_code(compressor, stat, a);
                } else {
                    if (stat instanceof AST_LoopControl) {
                        var lct = compressor.loopcontrol_target(stat.label);
                        if ((stat instanceof AST_Break
                             && lct instanceof AST_BlockStatement
                             && loop_body(lct) === self) || (stat instanceof AST_Continue
                                                             && loop_body(lct) === self)) {
                            if (stat.label) {
                                remove(stat.label.thedef.references, stat);
                            }
                        } else {
                            a.push(stat);
                        }
                    } else {
                        a.push(stat);
                    }
                    if (aborts(stat)) has_quit = true;
                }
                return a;
            }, []);
            CHANGED = statements.length != orig;
            return statements;
        };

        function sequencesize(statements, compressor) {
            if (statements.length < 2) return statements;
            var seq = [], ret = [];
            function push_seq() {
                seq = AST_Seq.from_array(seq);
                if (seq) ret.push(make_node(AST_SimpleStatement, seq, {
                    body: seq
                }));
                seq = [];
            };
            statements.forEach(function(stat){
                if (stat instanceof AST_SimpleStatement) {
                    if (seqLength(seq) >= compressor.sequences_limit) {
                        push_seq();
                    }
                    seq.push(seq.length > 0 ? statement_to_expression(stat) : stat.body);
                } else {
                    push_seq();
                    ret.push(stat);
                }
            });
            push_seq();
            ret = sequencesize_2(ret, compressor);
            CHANGED = ret.length != statements.length;
            return ret;
        };

        function seqLength(a) {
            for (var len = 0, i = 0; i < a.length; ++i) {
                var stat = a[i];
                if (stat instanceof AST_Seq) {
                    len += stat.len();
                } else {
                    len++;
                }
            }
            return len;
        };

        function sequencesize_2(statements, compressor) {
            function cons_seq(right) {
                ret.pop();
                var left = prev.body;
                if (left instanceof AST_Seq) {
                    left.add(right);
                } else {
                    left = AST_Seq.cons(left, right);
                }
                return left.transform(compressor);
            };
            var ret = [], prev = null;
            statements.forEach(function(stat){
                if (prev) {
                    if (stat instanceof AST_For) {
                        var opera = {};
                        try {
                            prev.body.walk(new TreeWalker(function(node){
                                if (node instanceof AST_Binary && node.operator == "in")
                                    throw opera;
                            }));
                            if (stat.init && !(stat.init instanceof AST_Definitions)) {
                                stat.init = cons_seq(stat.init);
                            }
                            else if (!stat.init) {
                                stat.init = statement_to_expression(prev);
                                ret.pop();
                            }
                        } catch(ex) {
                            if (ex !== opera) throw ex;
                        }
                    }
                    else if (stat instanceof AST_If) {
                        stat.condition = cons_seq(stat.condition);
                    }
                    else if (stat instanceof AST_With) {
                        stat.expression = cons_seq(stat.expression);
                    }
                    else if (stat instanceof AST_Exit && stat.value) {
                        stat.value = cons_seq(stat.value);
                    }
                    else if (stat instanceof AST_Exit) {
                        stat.value = cons_seq(make_node(AST_Undefined, stat));
                    }
                    else if (stat instanceof AST_Switch) {
                        stat.expression = cons_seq(stat.expression);
                    }
                }
                ret.push(stat);
                prev = stat instanceof AST_SimpleStatement ? stat : null;
            });
            return ret;
        };

        function join_consecutive_vars(statements, compressor) {
            var prev = null;
            return statements.reduce(function(a, stat){
                if (stat instanceof AST_Definitions && prev && prev.TYPE == stat.TYPE) {
                    prev.definitions = prev.definitions.concat(stat.definitions);
                    CHANGED = true;
                }
                else if (stat instanceof AST_For
                         && prev instanceof AST_Var
                         && (!stat.init || stat.init.TYPE == prev.TYPE)) {
                    CHANGED = true;
                    a.pop();
                    if (stat.init) {
                        stat.init.definitions = prev.definitions.concat(stat.init.definitions);
                    } else {
                        stat.init = prev;
                    }
                    a.push(stat);
                    prev = stat;
                }
                else {
                    prev = stat;
                    a.push(stat);
                }
                return a;
            }, []);
        };

    };

    function extract_functions_from_statement_array(statements) {
        var funs = [];
        for (var i = statements.length - 1; i >= 0; --i) {
            var stat = statements[i];
            if (stat instanceof AST_Defun) {
                statements.splice(i, 1);
                funs.unshift(stat);
            }
        }
        return funs;
    }

    function extract_declarations_from_unreachable_code(compressor, stat, target) {
        if (!(stat instanceof AST_Defun)) {
            compressor.warn("Dropping unreachable code [{file}:{line},{col}]", stat.start);
        }
        stat.walk(new TreeWalker(function(node){
            if (node instanceof AST_Definitions) {
                compressor.warn("Declarations in unreachable code! [{file}:{line},{col}]", node.start);
                node.remove_initializers();
                target.push(node);
                return true;
            }
            if (node instanceof AST_Defun) {
                target.push(node);
                return true;
            }
            if (node instanceof AST_Scope) {
                return true;
            }
        }));
    };

    /* -----[ boolean/negation helpers ]----- */

    // methods to determine whether an expression has a boolean result type
    (function (def){
        var unary_bool = [ "!", "delete" ];
        var binary_bool = [ "in", "instanceof", "==", "!=", "===", "!==", "<", "<=", ">=", ">" ];
        def(AST_Node, return_false);
        def(AST_UnaryPrefix, function(){
            return member(this.operator, unary_bool);
        });
        def(AST_Binary, function(){
            return member(this.operator, binary_bool) ||
                ( (this.operator == "&&" || this.operator == "||") &&
                  this.left.is_boolean() && this.right.is_boolean() );
        });
        def(AST_Conditional, function(){
            return this.consequent.is_boolean() && this.alternative.is_boolean();
        });
        def(AST_Assign, function(){
            return this.operator == "=" && this.right.is_boolean();
        });
        def(AST_Seq, function(){
            return this.cdr.is_boolean();
        });
        def(AST_True, return_true);
        def(AST_False, return_true);
    })(function(node, func){
        node.DEFMETHOD("is_boolean", func);
    });

    // methods to determine if an expression has a string result type
    (function (def){
        def(AST_Node, return_false);
        def(AST_String, return_true);
        def(AST_UnaryPrefix, function(){
            return this.operator == "typeof";
        });
        def(AST_Binary, function(compressor){
            return this.operator == "+" &&
                (this.left.is_string(compressor) || this.right.is_string(compressor));
        });
        def(AST_Assign, function(compressor){
            return (this.operator == "=" || this.operator == "+=") && this.right.is_string(compressor);
        });
        def(AST_Seq, function(compressor){
            return this.cdr.is_string(compressor);
        });
        def(AST_Conditional, function(compressor){
            return this.consequent.is_string(compressor) && this.alternative.is_string(compressor);
        });
        def(AST_Call, function(compressor){
            return compressor.option("unsafe")
                && this.expression instanceof AST_SymbolRef
                && this.expression.name == "String"
                && this.expression.undeclared();
        });
    })(function(node, func){
        node.DEFMETHOD("is_string", func);
    });

    function isLHS(node, parent) {
        return parent instanceof AST_Unary && (parent.operator === "++" || parent.operator === "--")
            || parent instanceof AST_Assign && parent.left === node;
    }

    (function (def){
        AST_Node.DEFMETHOD("resolve_defines", function(compressor) {
            if (!compressor.option("global_defs")) return;
            var def = this._find_defs(compressor, "");
            if (def) {
                var node, parent = this, level = 0;
                do {
                    node = parent;
                    parent = compressor.parent(level++);
                } while (parent instanceof AST_PropAccess && parent.expression === node);
                if (isLHS(node, parent)) {
                    compressor.warn('global_defs ' + this.print_to_string() + ' redefined [{file}:{line},{col}]', this.start);
                } else {
                    return def;
                }
            }
        });
        function to_node(compressor, value, orig) {
            if (value instanceof AST_Node) return make_node(value.CTOR, orig, value);
            if (Array.isArray(value)) return make_node(AST_Array, orig, {
                elements: value.map(function(value) {
                    return to_node(compressor, value, orig);
                })
            });
            if (value && typeof value == "object") {
                var props = [];
                for (var key in value) {
                    props.push(make_node(AST_ObjectKeyVal, orig, {
                        key: key,
                        value: to_node(compressor, value[key], orig)
                    }));
                }
                return make_node(AST_Object, orig, {
                    properties: props
                });
            }
            return make_node_from_constant(compressor, value, orig);
        }
        def(AST_Node, noop);
        def(AST_Dot, function(compressor, suffix){
            return this.expression._find_defs(compressor, suffix + "." + this.property);
        });
        def(AST_SymbolRef, function(compressor, suffix){
            if (!this.global()) return;
            var name;
            var defines = compressor.option("global_defs");
            if (defines && HOP(defines, (name = this.name + suffix))) {
                var node = to_node(compressor, defines[name], this);
                var top = compressor.find_parent(AST_Toplevel);
                node.walk(new TreeWalker(function(node) {
                    if (node instanceof AST_SymbolRef) {
                        node.scope = top;
                        node.thedef = top.def_global(node);
                    }
                }));
                return node;
            }
        });
    })(function(node, func){
        node.DEFMETHOD("_find_defs", func);
    });

    function best_of(ast1, ast2) {
        return ast1.print_to_string().length >
            ast2.print_to_string().length
            ? ast2 : ast1;
    }

    function best_of_statement(ast1, ast2) {
        return best_of(make_node(AST_SimpleStatement, ast1, {
            body: ast1
        }), make_node(AST_SimpleStatement, ast2, {
            body: ast2
        })).body;
    }

    // methods to evaluate a constant expression
    (function (def){
        // The evaluate method returns an array with one or two
        // elements.  If the node has been successfully reduced to a
        // constant, then the second element tells us the value;
        // otherwise the second element is missing.  The first element
        // of the array is always an AST_Node descendant; if
        // evaluation was successful it's a node that represents the
        // constant; otherwise it's the original or a replacement node.
        AST_Node.DEFMETHOD("evaluate", function(compressor){
            if (!compressor.option("evaluate")) return [ this ];
            var val;
            try {
                val = this._eval(compressor);
            } catch(ex) {
                if (ex !== def) throw ex;
                return [ this ];
            }
            var node;
            try {
                node = make_node_from_constant(compressor, val, this);
            } catch(ex) {
                return [ this ];
            }
            return [ best_of(node, this), val ];
        });
        var unaryPrefix = makePredicate("! ~ - +");
        AST_Node.DEFMETHOD("is_constant", function(){
            // Accomodate when compress option evaluate=false
            // as well as the common constant expressions !0 and -1
            if (this instanceof AST_Constant) {
                return !(this instanceof AST_RegExp);
            } else {
                return this instanceof AST_UnaryPrefix
                    && this.expression instanceof AST_Constant
                    && unaryPrefix(this.operator);
            }
        });
        // Obtain the constant value of an expression already known to be constant.
        // Result only valid iff this.is_constant() is true.
        AST_Node.DEFMETHOD("constant_value", function(compressor){
            // Accomodate when option evaluate=false.
            if (this instanceof AST_Constant && !(this instanceof AST_RegExp)) {
                return this.value;
            }
            // Accomodate the common constant expressions !0 and -1 when option evaluate=false.
            if (this instanceof AST_UnaryPrefix
                && this.expression instanceof AST_Constant) switch (this.operator) {
              case "!":
                return !this.expression.value;
              case "~":
                return ~this.expression.value;
              case "-":
                return -this.expression.value;
              case "+":
                return +this.expression.value;
              default:
                throw new Error(string_template("Cannot evaluate unary expression {value}", {
                    value: this.print_to_string()
                }));
            }
            var result = this.evaluate(compressor);
            if (result.length > 1) {
                return result[1];
            }
            throw new Error(string_template("Cannot evaluate constant [{file}:{line},{col}]", this.start));
        });
        def(AST_Statement, function(){
            throw new Error(string_template("Cannot evaluate a statement [{file}:{line},{col}]", this.start));
        });
        // XXX: AST_Accessor and AST_Function both inherit from AST_Scope,
        // which itself inherits from AST_Statement; however, they aren't
        // really statements.  This could bite in other places too. :-(
        // Wish JS had multiple inheritance.
        def(AST_Accessor, function(){
            throw def;
        });
        def(AST_Function, function(){
            throw def;
        });
        function ev(node, compressor) {
            if (!compressor) throw new Error("Compressor must be passed");

            return node._eval(compressor);
        };
        def(AST_Node, function(){
            throw def;          // not constant
        });
        def(AST_Constant, function(){
            return this.getValue();
        });
        def(AST_Array, function(compressor){
            if (compressor.option("unsafe")) {
                return this.elements.map(function(element) {
                    return ev(element, compressor);
                });
            }
            throw def;
        });
        def(AST_Object, function(compressor){
            if (compressor.option("unsafe")) {
                var val = {};
                for (var i = 0, len = this.properties.length; i < len; i++) {
                    var prop = this.properties[i];
                    var key = prop.key;
                    if (key instanceof AST_Symbol) {
                        key = key.name;
                    } else if (key instanceof AST_Node) {
                        key = ev(key, compressor);
                    }
                    if (typeof Object.prototype[key] === 'function') {
                        throw def;
                    }
                    val[key] = ev(prop.value, compressor);
                }
                return val;
            }
            throw def;
        });
        def(AST_UnaryPrefix, function(compressor){
            var e = this.expression;
            switch (this.operator) {
              case "!": return !ev(e, compressor);
              case "typeof":
                // Function would be evaluated to an array and so typeof would
                // incorrectly return 'object'. Hence making is a special case.
                if (e instanceof AST_Function) return typeof function(){};

                e = ev(e, compressor);

                // typeof <RegExp> returns "object" or "function" on different platforms
                // so cannot evaluate reliably
                if (e instanceof RegExp) throw def;

                return typeof e;
              case "void": return void ev(e, compressor);
              case "~": return ~ev(e, compressor);
              case "-": return -ev(e, compressor);
              case "+": return +ev(e, compressor);
            }
            throw def;
        });
        def(AST_Binary, function(c){
            var left = this.left, right = this.right, result;
            switch (this.operator) {
              case "&&"  : result = ev(left, c) &&  ev(right, c); break;
              case "||"  : result = ev(left, c) ||  ev(right, c); break;
              case "|"   : result = ev(left, c) |   ev(right, c); break;
              case "&"   : result = ev(left, c) &   ev(right, c); break;
              case "^"   : result = ev(left, c) ^   ev(right, c); break;
              case "+"   : result = ev(left, c) +   ev(right, c); break;
              case "*"   : result = ev(left, c) *   ev(right, c); break;
              case "/"   : result = ev(left, c) /   ev(right, c); break;
              case "%"   : result = ev(left, c) %   ev(right, c); break;
              case "-"   : result = ev(left, c) -   ev(right, c); break;
              case "<<"  : result = ev(left, c) <<  ev(right, c); break;
              case ">>"  : result = ev(left, c) >>  ev(right, c); break;
              case ">>>" : result = ev(left, c) >>> ev(right, c); break;
              case "=="  : result = ev(left, c) ==  ev(right, c); break;
              case "===" : result = ev(left, c) === ev(right, c); break;
              case "!="  : result = ev(left, c) !=  ev(right, c); break;
              case "!==" : result = ev(left, c) !== ev(right, c); break;
              case "<"   : result = ev(left, c) <   ev(right, c); break;
              case "<="  : result = ev(left, c) <=  ev(right, c); break;
              case ">"   : result = ev(left, c) >   ev(right, c); break;
              case ">="  : result = ev(left, c) >=  ev(right, c); break;
              default:
                  throw def;
            }
            if (isNaN(result) && c.find_parent(AST_With)) {
                // leave original expression as is
                throw def;
            }
            return result;
        });
        def(AST_Conditional, function(compressor){
            return ev(this.condition, compressor)
                ? ev(this.consequent, compressor)
                : ev(this.alternative, compressor);
        });
        def(AST_SymbolRef, function(compressor){
            if (this._evaluating) throw def;
            this._evaluating = true;
            try {
                var d = this.definition();
                if (compressor.option("reduce_vars") && d.fixed && d.init) {
                    if (compressor.option("unsafe")) {
                        if (d.init._evaluated === undefined) {
                            d.init._evaluated = ev(d.init, compressor);
                        }
                        return d.init._evaluated;
                    }
                    return ev(d.init, compressor);
                }
            } finally {
                this._evaluating = false;
            }
            throw def;
        });
        def(AST_PropAccess, function(compressor){
            if (compressor.option("unsafe")) {
                var key = this.property;
                if (key instanceof AST_Node) {
                    key = ev(key, compressor);
                }
                var val = ev(this.expression, compressor);
                if (val && HOP(val, key)) {
                    return val[key];
                }
            }
            throw def;
        });
    })(function(node, func){
        node.DEFMETHOD("_eval", func);
    });

    // method to negate an expression
    (function(def){
        function basic_negation(exp) {
            return make_node(AST_UnaryPrefix, exp, {
                operator: "!",
                expression: exp
            });
        }
        function best(orig, alt, first_in_statement) {
            var negated = basic_negation(orig);
            if (first_in_statement) {
                var stat = make_node(AST_SimpleStatement, alt, {
                    body: alt
                });
                return best_of(negated, stat) === stat ? alt : negated;
            }
            return best_of(negated, alt);
        }
        def(AST_Node, function(){
            return basic_negation(this);
        });
        def(AST_Statement, function(){
            throw new Error("Cannot negate a statement");
        });
        def(AST_Function, function(){
            return basic_negation(this);
        });
        def(AST_UnaryPrefix, function(){
            if (this.operator == "!")
                return this.expression;
            return basic_negation(this);
        });
        def(AST_Seq, function(compressor){
            var self = this.clone();
            self.cdr = self.cdr.negate(compressor);
            return self;
        });
        def(AST_Conditional, function(compressor, first_in_statement){
            var self = this.clone();
            self.consequent = self.consequent.negate(compressor);
            self.alternative = self.alternative.negate(compressor);
            return best(this, self, first_in_statement);
        });
        def(AST_Binary, function(compressor, first_in_statement){
            var self = this.clone(), op = this.operator;
            if (compressor.option("unsafe_comps")) {
                switch (op) {
                  case "<=" : self.operator = ">"  ; return self;
                  case "<"  : self.operator = ">=" ; return self;
                  case ">=" : self.operator = "<"  ; return self;
                  case ">"  : self.operator = "<=" ; return self;
                }
            }
            switch (op) {
              case "==" : self.operator = "!="; return self;
              case "!=" : self.operator = "=="; return self;
              case "===": self.operator = "!=="; return self;
              case "!==": self.operator = "==="; return self;
              case "&&":
                self.operator = "||";
                self.left = self.left.negate(compressor, first_in_statement);
                self.right = self.right.negate(compressor);
                return best(this, self, first_in_statement);
              case "||":
                self.operator = "&&";
                self.left = self.left.negate(compressor, first_in_statement);
                self.right = self.right.negate(compressor);
                return best(this, self, first_in_statement);
            }
            return basic_negation(this);
        });
    })(function(node, func){
        node.DEFMETHOD("negate", function(compressor, first_in_statement){
            return func.call(this, compressor, first_in_statement);
        });
    });

    AST_Call.DEFMETHOD("has_pure_annotation", function(compressor) {
        if (!compressor.option("side_effects")) return false;
        if (this.pure !== undefined) return this.pure;
        var pure = false;
        var comments, last_comment;
        if (this.start
            && (comments = this.start.comments_before)
            && comments.length
            && /[@#]__PURE__/.test((last_comment = comments[comments.length - 1]).value)) {
            pure = last_comment;
        }
        return this.pure = pure;
    });

    // determine if expression has side effects
    (function(def){
        def(AST_Node, return_true);

        def(AST_EmptyStatement, return_false);
        def(AST_Constant, return_false);
        def(AST_This, return_false);

        def(AST_Call, function(compressor){
            if (!this.has_pure_annotation(compressor) && compressor.pure_funcs(this)) return true;
            for (var i = this.args.length; --i >= 0;) {
                if (this.args[i].has_side_effects(compressor))
                    return true;
            }
            return false;
        });

        def(AST_Block, function(compressor){
            for (var i = this.body.length; --i >= 0;) {
                if (this.body[i].has_side_effects(compressor))
                    return true;
            }
            return false;
        });

        def(AST_SimpleStatement, function(compressor){
            return this.body.has_side_effects(compressor);
        });
        def(AST_Defun, return_true);
        def(AST_Function, return_false);
        def(AST_Binary, function(compressor){
            return this.left.has_side_effects(compressor)
                || this.right.has_side_effects(compressor);
        });
        def(AST_Assign, return_true);
        def(AST_Conditional, function(compressor){
            return this.condition.has_side_effects(compressor)
                || this.consequent.has_side_effects(compressor)
                || this.alternative.has_side_effects(compressor);
        });
        def(AST_Unary, function(compressor){
            return this.operator == "delete"
                || this.operator == "++"
                || this.operator == "--"
                || this.expression.has_side_effects(compressor);
        });
        def(AST_SymbolRef, function(compressor){
            return this.global() && this.undeclared();
        });
        def(AST_Object, function(compressor){
            for (var i = this.properties.length; --i >= 0;)
                if (this.properties[i].has_side_effects(compressor))
                    return true;
            return false;
        });
        def(AST_ObjectProperty, function(compressor){
            return this.value.has_side_effects(compressor);
        });
        def(AST_Array, function(compressor){
            for (var i = this.elements.length; --i >= 0;)
                if (this.elements[i].has_side_effects(compressor))
                    return true;
            return false;
        });
        def(AST_Dot, function(compressor){
            if (!compressor.option("pure_getters")) return true;
            return this.expression.has_side_effects(compressor);
        });
        def(AST_Sub, function(compressor){
            if (!compressor.option("pure_getters")) return true;
            return this.expression.has_side_effects(compressor)
                || this.property.has_side_effects(compressor);
        });
        def(AST_PropAccess, function(compressor){
            return !compressor.option("pure_getters");
        });
        def(AST_Seq, function(compressor){
            return this.car.has_side_effects(compressor)
                || this.cdr.has_side_effects(compressor);
        });
    })(function(node, func){
        node.DEFMETHOD("has_side_effects", func);
    });

    // tell me if a statement aborts
    function aborts(thing) {
        return thing && thing.aborts();
    };
    (function(def){
        def(AST_Statement, function(){ return null });
        def(AST_Jump, function(){ return this });
        function block_aborts(){
            var n = this.body.length;
            return n > 0 && aborts(this.body[n - 1]);
        };
        def(AST_BlockStatement, block_aborts);
        def(AST_SwitchBranch, block_aborts);
        def(AST_If, function(){
            return this.alternative && aborts(this.body) && aborts(this.alternative) && this;
        });
    })(function(node, func){
        node.DEFMETHOD("aborts", func);
    });

    /* -----[ optimizers ]----- */

    OPT(AST_Directive, function(self, compressor){
        if (compressor.has_directive(self.value) === "up") {
            return make_node(AST_EmptyStatement, self);
        }
        return self;
    });

    OPT(AST_Debugger, function(self, compressor){
        if (compressor.option("drop_debugger"))
            return make_node(AST_EmptyStatement, self);
        return self;
    });

    OPT(AST_LabeledStatement, function(self, compressor){
        if (self.body instanceof AST_Break
            && compressor.loopcontrol_target(self.body.label) === self.body) {
            return make_node(AST_EmptyStatement, self);
        }
        return self.label.references.length == 0 ? self.body : self;
    });

    OPT(AST_Block, function(self, compressor){
        self.body = tighten_body(self.body, compressor);
        return self;
    });

    OPT(AST_BlockStatement, function(self, compressor){
        self.body = tighten_body(self.body, compressor);
        switch (self.body.length) {
          case 1: return self.body[0];
          case 0: return make_node(AST_EmptyStatement, self);
        }
        return self;
    });

    AST_Scope.DEFMETHOD("drop_unused", function(compressor){
        var self = this;
        if (compressor.has_directive("use asm")) return self;
        var toplevel = compressor.option("toplevel");
        if (compressor.option("unused")
            && (!(self instanceof AST_Toplevel) || toplevel)
            && !self.uses_eval
            && !self.uses_with) {
            var assign_as_unused = !/keep_assign/.test(compressor.option("unused"));
            var drop_funcs = /funcs/.test(toplevel);
            var drop_vars = /vars/.test(toplevel);
            if (!(self instanceof AST_Toplevel) || toplevel == true) {
                drop_funcs = drop_vars = true;
            }
            var in_use = [];
            var in_use_ids = Object.create(null); // avoid expensive linear scans of in_use
            if (self instanceof AST_Toplevel && compressor.top_retain) {
                self.variables.each(function(def) {
                    if (compressor.top_retain(def) && !(def.id in in_use_ids)) {
                        in_use_ids[def.id] = true;
                        in_use.push(def);
                    }
                });
            }
            var initializations = new Dictionary();
            // pass 1: find out which symbols are directly used in
            // this scope (not in nested scopes).
            var scope = this;
            var tw = new TreeWalker(function(node, descend){
                if (node !== self) {
                    if (node instanceof AST_Defun) {
                        if (!drop_funcs && scope === self) {
                            var node_def = node.name.definition();
                            if (!(node_def.id in in_use_ids)) {
                                in_use_ids[node_def.id] = true;
                                in_use.push(node_def);
                            }
                        }
                        initializations.add(node.name.name, node);
                        return true; // don't go in nested scopes
                    }
                    if (node instanceof AST_Definitions && scope === self) {
                        node.definitions.forEach(function(def){
                            if (!drop_vars) {
                                var node_def = def.name.definition();
                                if (!(node_def.id in in_use_ids)) {
                                    in_use_ids[node_def.id] = true;
                                    in_use.push(node_def);
                                }
                            }
                            if (def.value) {
                                initializations.add(def.name.name, def.value);
                                if (def.value.has_side_effects(compressor)) {
                                    def.value.walk(tw);
                                }
                            }
                        });
                        return true;
                    }
                    if (assign_as_unused
                        && node instanceof AST_Assign
                        && node.operator == "="
                        && node.left instanceof AST_SymbolRef
                        && scope === self) {
                        node.right.walk(tw);
                        return true;
                    }
                    if (node instanceof AST_SymbolRef) {
                        var node_def = node.definition();
                        if (!(node_def.id in in_use_ids)) {
                            in_use_ids[node_def.id] = true;
                            in_use.push(node_def);
                        }
                        return true;
                    }
                    if (node instanceof AST_Scope) {
                        var save_scope = scope;
                        scope = node;
                        descend();
                        scope = save_scope;
                        return true;
                    }
                }
            });
            self.walk(tw);
            // pass 2: for every used symbol we need to walk its
            // initialization code to figure out if it uses other
            // symbols (that may not be in_use).
            for (var i = 0; i < in_use.length; ++i) {
                in_use[i].orig.forEach(function(decl){
                    // undeclared globals will be instanceof AST_SymbolRef
                    var init = initializations.get(decl.name);
                    if (init) init.forEach(function(init){
                        var tw = new TreeWalker(function(node){
                            if (node instanceof AST_SymbolRef) {
                                var node_def = node.definition();
                                if (!(node_def.id in in_use_ids)) {
                                    in_use_ids[node_def.id] = true;
                                    in_use.push(node_def);
                                }
                            }
                        });
                        init.walk(tw);
                    });
                });
            }
            // pass 3: we should drop declarations not in_use
            var tt = new TreeTransformer(
                function before(node, descend, in_list) {
                    if (node instanceof AST_Function
                        && node.name
                        && !compressor.option("keep_fnames")
                        && !(node.name.definition().id in in_use_ids)) {
                        node.name = null;
                    }
                    if (node instanceof AST_Lambda && !(node instanceof AST_Accessor)) {
                        if (!compressor.option("keep_fargs")) {
                            for (var a = node.argnames, i = a.length; --i >= 0;) {
                                var sym = a[i];
                                if (!(sym.definition().id in in_use_ids)) {
                                    a.pop();
                                    compressor.warn("Dropping unused function argument {name} [{file}:{line},{col}]", {
                                        name : sym.name,
                                        file : sym.start.file,
                                        line : sym.start.line,
                                        col  : sym.start.col
                                    });
                                }
                                else break;
                            }
                        }
                    }
                    if (drop_funcs && node instanceof AST_Defun && node !== self) {
                        if (!(node.name.definition().id in in_use_ids)) {
                            compressor.warn("Dropping unused function {name} [{file}:{line},{col}]", {
                                name : node.name.name,
                                file : node.name.start.file,
                                line : node.name.start.line,
                                col  : node.name.start.col
                            });
                            return make_node(AST_EmptyStatement, node);
                        }
                        return node;
                    }
                    if (drop_vars && node instanceof AST_Definitions && !(tt.parent() instanceof AST_ForIn)) {
                        var def = node.definitions.filter(function(def){
                            if (def.name.definition().id in in_use_ids) return true;
                            var w = {
                                name : def.name.name,
                                file : def.name.start.file,
                                line : def.name.start.line,
                                col  : def.name.start.col
                            };
                            if (def.value && (def._unused_side_effects = def.value.drop_side_effect_free(compressor))) {
                                compressor.warn("Side effects in initialization of unused variable {name} [{file}:{line},{col}]", w);
                                return true;
                            }
                            compressor.warn("Dropping unused variable {name} [{file}:{line},{col}]", w);
                            return false;
                        });
                        // place uninitialized names at the start
                        def = mergeSort(def, function(a, b){
                            if (!a.value && b.value) return -1;
                            if (!b.value && a.value) return 1;
                            return 0;
                        });
                        // for unused names whose initialization has
                        // side effects, we can cascade the init. code
                        // into the next one, or next statement.
                        var side_effects = [];
                        for (var i = 0; i < def.length;) {
                            var x = def[i];
                            if (x._unused_side_effects) {
                                side_effects.push(x._unused_side_effects);
                                def.splice(i, 1);
                            } else {
                                if (side_effects.length > 0) {
                                    side_effects.push(x.value);
                                    x.value = AST_Seq.from_array(side_effects);
                                    side_effects = [];
                                }
                                ++i;
                            }
                        }
                        if (side_effects.length > 0) {
                            side_effects = make_node(AST_BlockStatement, node, {
                                body: [ make_node(AST_SimpleStatement, node, {
                                    body: AST_Seq.from_array(side_effects)
                                }) ]
                            });
                        } else {
                            side_effects = null;
                        }
                        if (def.length == 0 && !side_effects) {
                            return make_node(AST_EmptyStatement, node);
                        }
                        if (def.length == 0) {
                            return in_list ? MAP.splice(side_effects.body) : side_effects;
                        }
                        node.definitions = def;
                        if (side_effects) {
                            side_effects.body.unshift(node);
                            return in_list ? MAP.splice(side_effects.body) : side_effects;
                        }
                        return node;
                    }
                    if (drop_vars && assign_as_unused
                        && node instanceof AST_Assign
                        && node.operator == "="
                        && node.left instanceof AST_SymbolRef) {
                        var def = node.left.definition();
                        if (!(def.id in in_use_ids) && self.variables.get(def.name) === def) {
                            return node.right;
                        }
                    }
                    if (node instanceof AST_For) {
                        descend(node, this);

                        if (node.init instanceof AST_BlockStatement) {
                            // certain combination of unused name + side effect leads to:
                            //    https://github.com/mishoo/UglifyJS2/issues/44
                            // that's an invalid AST.
                            // We fix it at this stage by moving the `var` outside the `for`.

                            var body = node.init.body.slice(0, -1);
                            node.init = node.init.body.slice(-1)[0].body;
                            body.push(node);

                            return in_list ? MAP.splice(body) : make_node(AST_BlockStatement, node, {
                                body: body
                            });
                        }
                    }
                    if (node instanceof AST_Scope && node !== self)
                        return node;
                }
            );
            self.transform(tt);
        }
    });

    AST_Scope.DEFMETHOD("hoist_declarations", function(compressor){
        var self = this;
        if (compressor.has_directive("use asm")) return self;
        var hoist_funs = compressor.option("hoist_funs");
        var hoist_vars = compressor.option("hoist_vars");
        if (hoist_funs || hoist_vars) {
            var dirs = [];
            var hoisted = [];
            var vars = new Dictionary(), vars_found = 0, var_decl = 0;
            // let's count var_decl first, we seem to waste a lot of
            // space if we hoist `var` when there's only one.
            self.walk(new TreeWalker(function(node){
                if (node instanceof AST_Scope && node !== self)
                    return true;
                if (node instanceof AST_Var) {
                    ++var_decl;
                    return true;
                }
            }));
            hoist_vars = hoist_vars && var_decl > 1;
            var tt = new TreeTransformer(
                function before(node) {
                    if (node !== self) {
                        if (node instanceof AST_Directive) {
                            dirs.push(node);
                            return make_node(AST_EmptyStatement, node);
                        }
                        if (node instanceof AST_Defun && hoist_funs) {
                            hoisted.push(node);
                            return make_node(AST_EmptyStatement, node);
                        }
                        if (node instanceof AST_Var && hoist_vars) {
                            node.definitions.forEach(function(def){
                                vars.set(def.name.name, def);
                                ++vars_found;
                            });
                            var seq = node.to_assignments();
                            var p = tt.parent();
                            if (p instanceof AST_ForIn && p.init === node) {
                                if (seq == null) {
                                    var def = node.definitions[0].name;
                                    return make_node(AST_SymbolRef, def, def);
                                }
                                return seq;
                            }
                            if (p instanceof AST_For && p.init === node) {
                                return seq;
                            }
                            if (!seq) return make_node(AST_EmptyStatement, node);
                            return make_node(AST_SimpleStatement, node, {
                                body: seq
                            });
                        }
                        if (node instanceof AST_Scope)
                            return node; // to avoid descending in nested scopes
                    }
                }
            );
            self = self.transform(tt);
            if (vars_found > 0) {
                // collect only vars which don't show up in self's arguments list
                var defs = [];
                vars.each(function(def, name){
                    if (self instanceof AST_Lambda
                        && find_if(function(x){ return x.name == def.name.name },
                                   self.argnames)) {
                        vars.del(name);
                    } else {
                        def = def.clone();
                        def.value = null;
                        defs.push(def);
                        vars.set(name, def);
                    }
                });
                if (defs.length > 0) {
                    // try to merge in assignments
                    for (var i = 0; i < self.body.length;) {
                        if (self.body[i] instanceof AST_SimpleStatement) {
                            var expr = self.body[i].body, sym, assign;
                            if (expr instanceof AST_Assign
                                && expr.operator == "="
                                && (sym = expr.left) instanceof AST_Symbol
                                && vars.has(sym.name))
                            {
                                var def = vars.get(sym.name);
                                if (def.value) break;
                                def.value = expr.right;
                                remove(defs, def);
                                defs.push(def);
                                self.body.splice(i, 1);
                                continue;
                            }
                            if (expr instanceof AST_Seq
                                && (assign = expr.car) instanceof AST_Assign
                                && assign.operator == "="
                                && (sym = assign.left) instanceof AST_Symbol
                                && vars.has(sym.name))
                            {
                                var def = vars.get(sym.name);
                                if (def.value) break;
                                def.value = assign.right;
                                remove(defs, def);
                                defs.push(def);
                                self.body[i].body = expr.cdr;
                                continue;
                            }
                        }
                        if (self.body[i] instanceof AST_EmptyStatement) {
                            self.body.splice(i, 1);
                            continue;
                        }
                        if (self.body[i] instanceof AST_BlockStatement) {
                            var tmp = [ i, 1 ].concat(self.body[i].body);
                            self.body.splice.apply(self.body, tmp);
                            continue;
                        }
                        break;
                    }
                    defs = make_node(AST_Var, self, {
                        definitions: defs
                    });
                    hoisted.push(defs);
                };
            }
            self.body = dirs.concat(hoisted, self.body);
        }
        return self;
    });

    // drop_side_effect_free()
    // remove side-effect-free parts which only affects return value
    (function(def){
        function return_this() {
            return this;
        }

        function return_null() {
            return null;
        }

        // Drop side-effect-free elements from an array of expressions.
        // Returns an array of expressions with side-effects or null
        // if all elements were dropped. Note: original array may be
        // returned if nothing changed.
        function trim(nodes, compressor, first_in_statement) {
            var ret = [], changed = false;
            for (var i = 0, len = nodes.length; i < len; i++) {
                var node = nodes[i].drop_side_effect_free(compressor, first_in_statement);
                changed |= node !== nodes[i];
                if (node) {
                    ret.push(node);
                    first_in_statement = false;
                }
            }
            return changed ? ret.length ? ret : null : nodes;
        }

        def(AST_Node, return_this);
        def(AST_Constant, return_null);
        def(AST_This, return_null);
        def(AST_Call, function(compressor, first_in_statement){
            if (!this.has_pure_annotation(compressor) && compressor.pure_funcs(this)) return this;
            if (this.pure) {
                compressor.warn("Dropping __PURE__ call [{file}:{line},{col}]", this.start);
                this.pure.value = this.pure.value.replace(/[@#]__PURE__/g, ' ');
            }
            var args = trim(this.args, compressor, first_in_statement);
            return args && AST_Seq.from_array(args);
        });
        def(AST_Function, return_null);
        def(AST_Binary, function(compressor, first_in_statement){
            var right = this.right.drop_side_effect_free(compressor);
            if (!right) return this.left.drop_side_effect_free(compressor, first_in_statement);
            switch (this.operator) {
              case "&&":
              case "||":
                var node = this.clone();
                node.right = right;
                return node;
              default:
                var left = this.left.drop_side_effect_free(compressor, first_in_statement);
                if (!left) return this.right.drop_side_effect_free(compressor, first_in_statement);
                return make_node(AST_Seq, this, {
                    car: left,
                    cdr: right
                });
            }
        });
        def(AST_Assign, return_this);
        def(AST_Conditional, function(compressor){
            var consequent = this.consequent.drop_side_effect_free(compressor);
            var alternative = this.alternative.drop_side_effect_free(compressor);
            if (consequent === this.consequent && alternative === this.alternative) return this;
            if (!consequent) return alternative ? make_node(AST_Binary, this, {
                operator: "||",
                left: this.condition,
                right: alternative
            }) : this.condition.drop_side_effect_free(compressor);
            if (!alternative) return make_node(AST_Binary, this, {
                operator: "&&",
                left: this.condition,
                right: consequent
            });
            var node = this.clone();
            node.consequent = consequent;
            node.alternative = alternative;
            return node;
        });
        def(AST_Unary, function(compressor, first_in_statement){
            switch (this.operator) {
              case "delete":
              case "++":
              case "--":
                return this;
              case "typeof":
                if (this.expression instanceof AST_SymbolRef) return null;
              default:
                var expression = this.expression.drop_side_effect_free(compressor, first_in_statement);
                if (first_in_statement
                    && this instanceof AST_UnaryPrefix
                    && is_iife_call(expression)) {
                    if (expression === this.expression && this.operator.length === 1) return this;
                    return make_node(AST_UnaryPrefix, this, {
                        operator: this.operator.length === 1 ? this.operator : "!",
                        expression: expression
                    });
                }
                return expression;
            }
        });
        def(AST_SymbolRef, function() {
            return this.undeclared() ? this : null;
        });
        def(AST_Object, function(compressor, first_in_statement){
            var values = trim(this.properties, compressor, first_in_statement);
            return values && AST_Seq.from_array(values);
        });
        def(AST_ObjectProperty, function(compressor, first_in_statement){
            return this.value.drop_side_effect_free(compressor, first_in_statement);
        });
        def(AST_Array, function(compressor, first_in_statement){
            var values = trim(this.elements, compressor, first_in_statement);
            return values && AST_Seq.from_array(values);
        });
        def(AST_Dot, function(compressor, first_in_statement){
            if (!compressor.option("pure_getters")) return this;
            return this.expression.drop_side_effect_free(compressor, first_in_statement);
        });
        def(AST_Sub, function(compressor, first_in_statement){
            if (!compressor.option("pure_getters")) return this;
            var expression = this.expression.drop_side_effect_free(compressor, first_in_statement);
            if (!expression) return this.property.drop_side_effect_free(compressor, first_in_statement);
            var property = this.property.drop_side_effect_free(compressor);
            if (!property) return expression;
            return make_node(AST_Seq, this, {
                car: expression,
                cdr: property
            });
        });
        def(AST_Seq, function(compressor){
            var cdr = this.cdr.drop_side_effect_free(compressor);
            if (cdr === this.cdr) return this;
            if (!cdr) return this.car;
            return make_node(AST_Seq, this, {
                car: this.car,
                cdr: cdr
            });
        });
    })(function(node, func){
        node.DEFMETHOD("drop_side_effect_free", func);
    });

    OPT(AST_SimpleStatement, function(self, compressor){
        if (compressor.option("side_effects")) {
            var body = self.body;
            var node = body.drop_side_effect_free(compressor, true);
            if (!node) {
                compressor.warn("Dropping side-effect-free statement [{file}:{line},{col}]", self.start);
                return make_node(AST_EmptyStatement, self);
            }
            if (node !== body) {
                return make_node(AST_SimpleStatement, self, { body: node });
            }
        }
        return self;
    });

    OPT(AST_DWLoop, function(self, compressor){
        var cond = self.condition.evaluate(compressor);
        self.condition = cond[0];
        if (!compressor.option("loops")) return self;
        if (cond.length > 1) {
            if (cond[1]) {
                return make_node(AST_For, self, {
                    body: self.body
                });
            } else if (self instanceof AST_While) {
                if (compressor.option("dead_code")) {
                    var a = [];
                    extract_declarations_from_unreachable_code(compressor, self.body, a);
                    return make_node(AST_BlockStatement, self, { body: a });
                }
            } else {
                // self instanceof AST_Do
                return self.body;
            }
        }
        if (self instanceof AST_While) {
            return make_node(AST_For, self, self).transform(compressor);
        }
        return self;
    });

    function if_break_in_loop(self, compressor) {
        function drop_it(rest) {
            rest = as_statement_array(rest);
            if (self.body instanceof AST_BlockStatement) {
                self.body = self.body.clone();
                self.body.body = rest.concat(self.body.body.slice(1));
                self.body = self.body.transform(compressor);
            } else {
                self.body = make_node(AST_BlockStatement, self.body, {
                    body: rest
                }).transform(compressor);
            }
            if_break_in_loop(self, compressor);
        }
        var first = self.body instanceof AST_BlockStatement ? self.body.body[0] : self.body;
        if (first instanceof AST_If) {
            if (first.body instanceof AST_Break
                && compressor.loopcontrol_target(first.body.label) === self) {
                if (self.condition) {
                    self.condition = make_node(AST_Binary, self.condition, {
                        left: self.condition,
                        operator: "&&",
                        right: first.condition.negate(compressor),
                    });
                } else {
                    self.condition = first.condition.negate(compressor);
                }
                drop_it(first.alternative);
            }
            else if (first.alternative instanceof AST_Break
                     && compressor.loopcontrol_target(first.alternative.label) === self) {
                if (self.condition) {
                    self.condition = make_node(AST_Binary, self.condition, {
                        left: self.condition,
                        operator: "&&",
                        right: first.condition,
                    });
                } else {
                    self.condition = first.condition;
                }
                drop_it(first.body);
            }
        }
    };

    OPT(AST_For, function(self, compressor){
        var cond = self.condition;
        if (cond) {
            cond = cond.evaluate(compressor);
            self.condition = cond[0];
        }
        if (!compressor.option("loops")) return self;
        if (cond) {
            if (cond.length > 1 && !cond[1]) {
                if (compressor.option("dead_code")) {
                    var a = [];
                    if (self.init instanceof AST_Statement) {
                        a.push(self.init);
                    }
                    else if (self.init) {
                        a.push(make_node(AST_SimpleStatement, self.init, {
                            body: self.init
                        }));
                    }
                    extract_declarations_from_unreachable_code(compressor, self.body, a);
                    return make_node(AST_BlockStatement, self, { body: a });
                }
            }
        }
        if_break_in_loop(self, compressor);
        return self;
    });

    OPT(AST_If, function(self, compressor){
        if (is_empty(self.alternative)) self.alternative = null;

        if (!compressor.option("conditionals")) return self;
        // if condition can be statically determined, warn and drop
        // one of the blocks.  note, statically determined implies
        // “has no side effects”; also it doesn't work for cases like
        // `x && true`, though it probably should.
        var cond = self.condition.evaluate(compressor);
        self.condition = cond[0];
        if (cond.length > 1) {
            if (cond[1]) {
                compressor.warn("Condition always true [{file}:{line},{col}]", self.condition.start);
                if (compressor.option("dead_code")) {
                    var a = [];
                    if (self.alternative) {
                        extract_declarations_from_unreachable_code(compressor, self.alternative, a);
                    }
                    a.push(self.body);
                    return make_node(AST_BlockStatement, self, { body: a }).transform(compressor);
                }
            } else {
                compressor.warn("Condition always false [{file}:{line},{col}]", self.condition.start);
                if (compressor.option("dead_code")) {
                    var a = [];
                    extract_declarations_from_unreachable_code(compressor, self.body, a);
                    if (self.alternative) a.push(self.alternative);
                    return make_node(AST_BlockStatement, self, { body: a }).transform(compressor);
                }
            }
        }
        var negated = self.condition.negate(compressor);
        var self_condition_length = self.condition.print_to_string().length;
        var negated_length = negated.print_to_string().length;
        var negated_is_best = negated_length < self_condition_length;
        if (self.alternative && negated_is_best) {
            negated_is_best = false; // because we already do the switch here.
            // no need to swap values of self_condition_length and negated_length
            // here because they are only used in an equality comparison later on.
            self.condition = negated;
            var tmp = self.body;
            self.body = self.alternative || make_node(AST_EmptyStatement);
            self.alternative = tmp;
        }
        if (is_empty(self.body) && is_empty(self.alternative)) {
            return make_node(AST_SimpleStatement, self.condition, {
                body: self.condition
            }).transform(compressor);
        }
        if (self.body instanceof AST_SimpleStatement
            && self.alternative instanceof AST_SimpleStatement) {
            return make_node(AST_SimpleStatement, self, {
                body: make_node(AST_Conditional, self, {
                    condition   : self.condition,
                    consequent  : statement_to_expression(self.body),
                    alternative : statement_to_expression(self.alternative)
                })
            }).transform(compressor);
        }
        if (is_empty(self.alternative) && self.body instanceof AST_SimpleStatement) {
            if (self_condition_length === negated_length && !negated_is_best
                && self.condition instanceof AST_Binary && self.condition.operator == "||") {
                // although the code length of self.condition and negated are the same,
                // negated does not require additional surrounding parentheses.
                // see https://github.com/mishoo/UglifyJS2/issues/979
                negated_is_best = true;
            }
            if (negated_is_best) return make_node(AST_SimpleStatement, self, {
                body: make_node(AST_Binary, self, {
                    operator : "||",
                    left     : negated,
                    right    : statement_to_expression(self.body)
                })
            }).transform(compressor);
            return make_node(AST_SimpleStatement, self, {
                body: make_node(AST_Binary, self, {
                    operator : "&&",
                    left     : self.condition,
                    right    : statement_to_expression(self.body)
                })
            }).transform(compressor);
        }
        if (self.body instanceof AST_EmptyStatement
            && self.alternative
            && self.alternative instanceof AST_SimpleStatement) {
            return make_node(AST_SimpleStatement, self, {
                body: make_node(AST_Binary, self, {
                    operator : "||",
                    left     : self.condition,
                    right    : statement_to_expression(self.alternative)
                })
            }).transform(compressor);
        }
        if (self.body instanceof AST_Exit
            && self.alternative instanceof AST_Exit
            && self.body.TYPE == self.alternative.TYPE) {
            return make_node(self.body.CTOR, self, {
                value: make_node(AST_Conditional, self, {
                    condition   : self.condition,
                    consequent  : self.body.value || make_node(AST_Undefined, self.body).optimize(compressor),
                    alternative : self.alternative.value || make_node(AST_Undefined, self.alternative).optimize(compressor)
                })
            }).transform(compressor);
        }
        if (self.body instanceof AST_If
            && !self.body.alternative
            && !self.alternative) {
            self.condition = make_node(AST_Binary, self.condition, {
                operator: "&&",
                left: self.condition,
                right: self.body.condition
            }).transform(compressor);
            self.body = self.body.body;
        }
        if (aborts(self.body)) {
            if (self.alternative) {
                var alt = self.alternative;
                self.alternative = null;
                return make_node(AST_BlockStatement, self, {
                    body: [ self, alt ]
                }).transform(compressor);
            }
        }
        if (aborts(self.alternative)) {
            var body = self.body;
            self.body = self.alternative;
            self.condition = negated_is_best ? negated : self.condition.negate(compressor);
            self.alternative = null;
            return make_node(AST_BlockStatement, self, {
                body: [ self, body ]
            }).transform(compressor);
        }
        return self;
    });

    OPT(AST_Switch, function(self, compressor){
        if (self.body.length == 0 && compressor.option("conditionals")) {
            return make_node(AST_SimpleStatement, self, {
                body: self.expression
            }).transform(compressor);
        }
        for(;;) {
            var last_branch = self.body[self.body.length - 1];
            if (last_branch) {
                var stat = last_branch.body[last_branch.body.length - 1]; // last statement
                if (stat instanceof AST_Break && loop_body(compressor.loopcontrol_target(stat.label)) === self)
                    last_branch.body.pop();
                if (last_branch instanceof AST_Default && last_branch.body.length == 0) {
                    self.body.pop();
                    continue;
                }
            }
            break;
        }
        var exp = self.expression.evaluate(compressor);
        out: if (exp.length == 2) try {
            // constant expression
            self.expression = exp[0];
            if (!compressor.option("dead_code")) break out;
            var value = exp[1];
            var in_if = false;
            var in_block = false;
            var started = false;
            var stopped = false;
            var ruined = false;
            var tt = new TreeTransformer(function(node, descend, in_list){
                if (node instanceof AST_Lambda || node instanceof AST_SimpleStatement) {
                    // no need to descend these node types
                    return node;
                }
                else if (node instanceof AST_Switch && node === self) {
                    node = node.clone();
                    descend(node, this);
                    return ruined ? node : make_node(AST_BlockStatement, node, {
                        body: node.body.reduce(function(a, branch){
                            return a.concat(branch.body);
                        }, [])
                    }).transform(compressor);
                }
                else if (node instanceof AST_If || node instanceof AST_Try) {
                    var save = in_if;
                    in_if = !in_block;
                    descend(node, this);
                    in_if = save;
                    return node;
                }
                else if (node instanceof AST_StatementWithBody || node instanceof AST_Switch) {
                    var save = in_block;
                    in_block = true;
                    descend(node, this);
                    in_block = save;
                    return node;
                }
                else if (node instanceof AST_Break && this.loopcontrol_target(node.label) === self) {
                    if (in_if) {
                        ruined = true;
                        return node;
                    }
                    if (in_block) return node;
                    stopped = true;
                    return in_list ? MAP.skip : make_node(AST_EmptyStatement, node);
                }
                else if (node instanceof AST_SwitchBranch && this.parent() === self) {
                    if (stopped) return MAP.skip;
                    if (node instanceof AST_Case) {
                        var exp = node.expression.evaluate(compressor);
                        if (exp.length < 2) {
                            // got a case with non-constant expression, baling out
                            throw self;
                        }
                        if (exp[1] === value || started) {
                            started = true;
                            if (aborts(node)) stopped = true;
                            descend(node, this);
                            return node;
                        }
                        return MAP.skip;
                    }
                    descend(node, this);
                    return node;
                }
            });
            tt.stack = compressor.stack.slice(); // so that's able to see parent nodes
            self = self.transform(tt);
        } catch(ex) {
            if (ex !== self) throw ex;
        }
        return self;
    });

    OPT(AST_Case, function(self, compressor){
        self.body = tighten_body(self.body, compressor);
        return self;
    });

    OPT(AST_Try, function(self, compressor){
        self.body = tighten_body(self.body, compressor);
        return self;
    });

    AST_Definitions.DEFMETHOD("remove_initializers", function(){
        this.definitions.forEach(function(def){ def.value = null });
    });

    AST_Definitions.DEFMETHOD("to_assignments", function(){
        var assignments = this.definitions.reduce(function(a, def){
            if (def.value) {
                var name = make_node(AST_SymbolRef, def.name, def.name);
                a.push(make_node(AST_Assign, def, {
                    operator : "=",
                    left     : name,
                    right    : def.value
                }));
            }
            return a;
        }, []);
        if (assignments.length == 0) return null;
        return AST_Seq.from_array(assignments);
    });

    OPT(AST_Definitions, function(self, compressor){
        if (self.definitions.length == 0)
            return make_node(AST_EmptyStatement, self);
        return self;
    });

    OPT(AST_Call, function(self, compressor){
        if (compressor.option("unsafe")) {
            var exp = self.expression;
            if (exp instanceof AST_SymbolRef && exp.undeclared()) {
                switch (exp.name) {
                  case "Array":
                    if (self.args.length != 1) {
                        return make_node(AST_Array, self, {
                            elements: self.args
                        }).transform(compressor);
                    }
                    break;
                  case "Object":
                    if (self.args.length == 0) {
                        return make_node(AST_Object, self, {
                            properties: []
                        });
                    }
                    break;
                  case "String":
                    if (self.args.length == 0) return make_node(AST_String, self, {
                        value: ""
                    });
                    if (self.args.length <= 1) return make_node(AST_Binary, self, {
                        left: self.args[0],
                        operator: "+",
                        right: make_node(AST_String, self, { value: "" })
                    }).transform(compressor);
                    break;
                  case "Number":
                    if (self.args.length == 0) return make_node(AST_Number, self, {
                        value: 0
                    });
                    if (self.args.length == 1) return make_node(AST_UnaryPrefix, self, {
                        expression: self.args[0],
                        operator: "+"
                    }).transform(compressor);
                  case "Boolean":
                    if (self.args.length == 0) return make_node(AST_False, self);
                    if (self.args.length == 1) return make_node(AST_UnaryPrefix, self, {
                        expression: make_node(AST_UnaryPrefix, null, {
                            expression: self.args[0],
                            operator: "!"
                        }),
                        operator: "!"
                    }).transform(compressor);
                    break;
                  case "Function":
                    // new Function() => function(){}
                    if (self.args.length == 0) return make_node(AST_Function, self, {
                        argnames: [],
                        body: []
                    });
                    if (all(self.args, function(x){ return x instanceof AST_String })) {
                        // quite a corner-case, but we can handle it:
                        //   https://github.com/mishoo/UglifyJS2/issues/203
                        // if the code argument is a constant, then we can minify it.
                        try {
                            var code = "(function(" + self.args.slice(0, -1).map(function(arg){
                                return arg.value;
                            }).join(",") + "){" + self.args[self.args.length - 1].value + "})()";
                            var ast = parse(code);
                            ast.figure_out_scope({ screw_ie8: compressor.option("screw_ie8") });
                            var comp = new Compressor(compressor.options);
                            ast = ast.transform(comp);
                            ast.figure_out_scope({ screw_ie8: compressor.option("screw_ie8") });
                            ast.mangle_names();
                            var fun;
                            try {
                                ast.walk(new TreeWalker(function(node){
                                    if (node instanceof AST_Lambda) {
                                        fun = node;
                                        throw ast;
                                    }
                                }));
                            } catch(ex) {
                                if (ex !== ast) throw ex;
                            };
                            if (!fun) return self;
                            var args = fun.argnames.map(function(arg, i){
                                return make_node(AST_String, self.args[i], {
                                    value: arg.print_to_string()
                                });
                            });
                            var code = OutputStream();
                            AST_BlockStatement.prototype._codegen.call(fun, fun, code);
                            code = code.toString().replace(/^\{|\}$/g, "");
                            args.push(make_node(AST_String, self.args[self.args.length - 1], {
                                value: code
                            }));
                            self.args = args;
                            return self;
                        } catch(ex) {
                            if (ex instanceof JS_Parse_Error) {
                                compressor.warn("Error parsing code passed to new Function [{file}:{line},{col}]", self.args[self.args.length - 1].start);
                                compressor.warn(ex.toString());
                            } else {
                                console.log(ex);
                                throw ex;
                            }
                        }
                    }
                    break;
                }
            }
            else if (exp instanceof AST_Dot && exp.property == "toString" && self.args.length == 0) {
                return make_node(AST_Binary, self, {
                    left: make_node(AST_String, self, { value: "" }),
                    operator: "+",
                    right: exp.expression
                }).transform(compressor);
            }
            else if (exp instanceof AST_Dot && exp.expression instanceof AST_Array && exp.property == "join") EXIT: {
                var separator;
                if (self.args.length > 0) {
                    separator = self.args[0].evaluate(compressor);
                    if (separator.length < 2) break EXIT; // not a constant
                    separator = separator[1];
                }
                var elements = [];
                var consts = [];
                exp.expression.elements.forEach(function(el) {
                    el = el.evaluate(compressor);
                    if (el.length > 1) {
                        consts.push(el[1]);
                    } else {
                        if (consts.length > 0) {
                            elements.push(make_node(AST_String, self, {
                                value: consts.join(separator)
                            }));
                            consts.length = 0;
                        }
                        elements.push(el[0]);
                    }
                });
                if (consts.length > 0) {
                    elements.push(make_node(AST_String, self, {
                        value: consts.join(separator)
                    }));
                }
                if (elements.length == 0) return make_node(AST_String, self, { value: "" });
                if (elements.length == 1) {
                    if (elements[0].is_string(compressor)) {
                        return elements[0];
                    }
                    return make_node(AST_Binary, elements[0], {
                        operator : "+",
                        left     : make_node(AST_String, self, { value: "" }),
                        right    : elements[0]
                    });
                }
                if (separator == "") {
                    var first;
                    if (elements[0].is_string(compressor)
                        || elements[1].is_string(compressor)) {
                        first = elements.shift();
                    } else {
                        first = make_node(AST_String, self, { value: "" });
                    }
                    return elements.reduce(function(prev, el){
                        return make_node(AST_Binary, el, {
                            operator : "+",
                            left     : prev,
                            right    : el
                        });
                    }, first).transform(compressor);
                }
                // need this awkward cloning to not affect original element
                // best_of will decide which one to get through.
                var node = self.clone();
                node.expression = node.expression.clone();
                node.expression.expression = node.expression.expression.clone();
                node.expression.expression.elements = elements;
                return best_of(self, node);
            }
        }
        if (compressor.option("side_effects")) {
            if (self.expression instanceof AST_Function
                && self.args.length == 0
                && !AST_Block.prototype.has_side_effects.call(self.expression, compressor)) {
                return make_node(AST_Undefined, self).transform(compressor);
            }
        }
        if (compressor.option("drop_console")) {
            if (self.expression instanceof AST_PropAccess) {
                var name = self.expression.expression;
                while (name.expression) {
                    name = name.expression;
                }
                if (name instanceof AST_SymbolRef
                    && name.name == "console"
                    && name.undeclared()) {
                    return make_node(AST_Undefined, self).transform(compressor);
                }
            }
        }
        if (compressor.option("negate_iife")
            && compressor.parent() instanceof AST_SimpleStatement
            && is_iife_call(self)) {
            return self.negate(compressor, true);
        }
        return self;
    });

    OPT(AST_New, function(self, compressor){
        if (compressor.option("unsafe")) {
            var exp = self.expression;
            if (exp instanceof AST_SymbolRef && exp.undeclared()) {
                switch (exp.name) {
                  case "Object":
                  case "RegExp":
                  case "Function":
                  case "Error":
                  case "Array":
                    return make_node(AST_Call, self, self).transform(compressor);
                }
            }
        }
        return self;
    });

    OPT(AST_Seq, function(self, compressor){
        if (!compressor.option("side_effects"))
            return self;
        self.car = self.car.drop_side_effect_free(compressor, first_in_statement(compressor));
        if (!self.car) return maintain_this_binding(compressor.parent(), self, self.cdr);
        if (compressor.option("cascade")) {
            if (self.car instanceof AST_Assign
                && !self.car.left.has_side_effects(compressor)) {
                if (self.car.left.equivalent_to(self.cdr)) {
                    return self.car;
                }
                if (self.cdr instanceof AST_Call
                    && self.cdr.expression.equivalent_to(self.car.left)) {
                    self.cdr.expression = self.car;
                    return self.cdr;
                }
            }
            if (!self.car.has_side_effects(compressor)
                && self.car.equivalent_to(self.cdr)) {
                return self.car;
            }
        }
        if (self.cdr instanceof AST_Undefined) {
            return make_node(AST_UnaryPrefix, self, {
                operator   : "void",
                expression : self.car
            });
        }
        return self;
    });

    AST_Unary.DEFMETHOD("lift_sequences", function(compressor){
        if (compressor.option("sequences")) {
            if (this.expression instanceof AST_Seq) {
                var seq = this.expression;
                var x = seq.to_array();
                this.expression = x.pop();
                x.push(this);
                seq = AST_Seq.from_array(x).transform(compressor);
                return seq;
            }
        }
        return this;
    });

    OPT(AST_UnaryPostfix, function(self, compressor){
        return self.lift_sequences(compressor);
    });

    OPT(AST_UnaryPrefix, function(self, compressor){
        var seq = self.lift_sequences(compressor);
        if (seq !== self) {
            return seq;
        }
        var e = self.expression;
        if (compressor.option("side_effects") && self.operator == "void") {
            e = e.drop_side_effect_free(compressor);
            if (e) {
                self.expression = e;
                return self;
            } else {
                return make_node(AST_Undefined, self);
            }
        }
        if (compressor.option("booleans") && compressor.in_boolean_context()) {
            switch (self.operator) {
              case "!":
                if (e instanceof AST_UnaryPrefix && e.operator == "!") {
                    // !!foo ==> foo, if we're in boolean context
                    return e.expression;
                }
                if (e instanceof AST_Binary) {
                    var statement = first_in_statement(compressor);
                    self = (statement ? best_of_statement : best_of)(self, e.negate(compressor, statement));
                }
                break;
              case "typeof":
                // typeof always returns a non-empty string, thus it's
                // always true in booleans
                compressor.warn("Boolean expression always true [{file}:{line},{col}]", self.start);
                return make_node(AST_Seq, self, {
                    car: e,
                    cdr: make_node(AST_True, self)
                }).optimize(compressor);
            }
        }
        return self.evaluate(compressor)[0];
    });

    function has_side_effects_or_prop_access(node, compressor) {
        var save_pure_getters = compressor.option("pure_getters");
        compressor.options.pure_getters = false;
        var ret = node.has_side_effects(compressor);
        compressor.options.pure_getters = save_pure_getters;
        return ret;
    }

    AST_Binary.DEFMETHOD("lift_sequences", function(compressor){
        if (compressor.option("sequences")) {
            if (this.left instanceof AST_Seq) {
                var seq = this.left;
                var x = seq.to_array();
                this.left = x.pop();
                x.push(this);
                seq = AST_Seq.from_array(x).transform(compressor);
                return seq;
            }
            if (this.right instanceof AST_Seq
                && this instanceof AST_Assign
                && !has_side_effects_or_prop_access(this.left, compressor)) {
                var seq = this.right;
                var x = seq.to_array();
                this.right = x.pop();
                x.push(this);
                seq = AST_Seq.from_array(x).transform(compressor);
                return seq;
            }
        }
        return this;
    });

    var commutativeOperators = makePredicate("== === != !== * & | ^");

    OPT(AST_Binary, function(self, compressor){
        var lhs = self.left.evaluate(compressor);
        var rhs = self.right.evaluate(compressor);
        if (lhs.length > 1 && lhs[0].is_constant() !== self.left.is_constant()
            || rhs.length > 1 && rhs[0].is_constant() !== self.right.is_constant()) {
            return make_node(AST_Binary, self, {
                operator: self.operator,
                left: lhs[0],
                right: rhs[0]
            }).optimize(compressor);
        }
        function reverse(op, force) {
            if (force || !(self.left.has_side_effects(compressor) || self.right.has_side_effects(compressor))) {
                if (op) self.operator = op;
                var tmp = self.left;
                self.left = self.right;
                self.right = tmp;
            }
        }
        if (commutativeOperators(self.operator)) {
            if (self.right instanceof AST_Constant
                && !(self.left instanceof AST_Constant)) {
                // if right is a constant, whatever side effects the
                // left side might have could not influence the
                // result.  hence, force switch.

                if (!(self.left instanceof AST_Binary
                      && PRECEDENCE[self.left.operator] >= PRECEDENCE[self.operator])) {
                    reverse(null, true);
                }
            }
            if (/^[!=]==?$/.test(self.operator)) {
                if (self.left instanceof AST_SymbolRef && self.right instanceof AST_Conditional) {
                    if (self.right.consequent instanceof AST_SymbolRef
                        && self.right.consequent.definition() === self.left.definition()) {
                        if (/^==/.test(self.operator)) return self.right.condition;
                        if (/^!=/.test(self.operator)) return self.right.condition.negate(compressor);
                    }
                    if (self.right.alternative instanceof AST_SymbolRef
                        && self.right.alternative.definition() === self.left.definition()) {
                        if (/^==/.test(self.operator)) return self.right.condition.negate(compressor);
                        if (/^!=/.test(self.operator)) return self.right.condition;
                    }
                }
                if (self.right instanceof AST_SymbolRef && self.left instanceof AST_Conditional) {
                    if (self.left.consequent instanceof AST_SymbolRef
                        && self.left.consequent.definition() === self.right.definition()) {
                        if (/^==/.test(self.operator)) return self.left.condition;
                        if (/^!=/.test(self.operator)) return self.left.condition.negate(compressor);
                    }
                    if (self.left.alternative instanceof AST_SymbolRef
                        && self.left.alternative.definition() === self.right.definition()) {
                        if (/^==/.test(self.operator)) return self.left.condition.negate(compressor);
                        if (/^!=/.test(self.operator)) return self.left.condition;
                    }
                }
            }
        }
        self = self.lift_sequences(compressor);
        if (compressor.option("comparisons")) switch (self.operator) {
          case "===":
          case "!==":
            if ((self.left.is_string(compressor) && self.right.is_string(compressor)) ||
                (self.left.is_boolean() && self.right.is_boolean())) {
                self.operator = self.operator.substr(0, 2);
            }
            // XXX: intentionally falling down to the next case
          case "==":
          case "!=":
            // "undefined" == typeof x => undefined === x
            if (self.left instanceof AST_String
                && self.left.value == "undefined"
                && self.right instanceof AST_UnaryPrefix
                && self.right.operator == "typeof") {
                var expr = self.right.expression;
                if (expr instanceof AST_SymbolRef ? !expr.undeclared()
                    : !(expr instanceof AST_PropAccess) || compressor.option("screw_ie8")) {
                    self.right = expr;
                    self.left = make_node(AST_Undefined, self.left).optimize(compressor);
                    if (self.operator.length == 2) self.operator += "=";
                }
            }
            break;
        }
        if (compressor.option("booleans") && compressor.in_boolean_context()) switch (self.operator) {
          case "&&":
            var ll = self.left.evaluate(compressor);
            var rr = self.right.evaluate(compressor);
            if ((ll.length > 1 && !ll[1]) || (rr.length > 1 && !rr[1])) {
                compressor.warn("Boolean && always false [{file}:{line},{col}]", self.start);
                return make_node(AST_Seq, self, {
                    car: self.left,
                    cdr: make_node(AST_False)
                }).optimize(compressor);
            }
            if (ll.length > 1 && ll[1]) {
                return rr[0];
            }
            if (rr.length > 1 && rr[1]) {
                return ll[0];
            }
            break;
          case "||":
            var ll = self.left.evaluate(compressor);
            var rr = self.right.evaluate(compressor);
            if ((ll.length > 1 && ll[1]) || (rr.length > 1 && rr[1])) {
                compressor.warn("Boolean || always true [{file}:{line},{col}]", self.start);
                return make_node(AST_Seq, self, {
                    car: self.left,
                    cdr: make_node(AST_True, self)
                }).optimize(compressor);
            }
            if (ll.length > 1 && !ll[1]) {
                return rr[0];
            }
            if (rr.length > 1 && !rr[1]) {
                return ll[0];
            }
            break;
          case "+":
            var ll = self.left.evaluate(compressor);
            var rr = self.right.evaluate(compressor);
            if (ll.length > 1 && ll[0] instanceof AST_String && ll[1]) {
                compressor.warn("+ in boolean context always true [{file}:{line},{col}]", self.start);
                return make_node(AST_Seq, self, {
                    car: self.right,
                    cdr: make_node(AST_True, self)
                }).optimize(compressor);
            }
            if (rr.length > 1 && rr[0] instanceof AST_String && rr[1]) {
                compressor.warn("+ in boolean context always true [{file}:{line},{col}]", self.start);
                return make_node(AST_Seq, self, {
                    car: self.left,
                    cdr: make_node(AST_True, self)
                }).optimize(compressor);
            }
            break;
        }
        if (compressor.option("comparisons") && self.is_boolean()) {
            if (!(compressor.parent() instanceof AST_Binary)
                || compressor.parent() instanceof AST_Assign) {
                var statement = first_in_statement(compressor);
                var negated = make_node(AST_UnaryPrefix, self, {
                    operator: "!",
                    expression: self.negate(compressor, statement)
                });
                self = (statement ? best_of_statement : best_of)(self, negated);
            }
            if (compressor.option("unsafe_comps")) {
                switch (self.operator) {
                  case "<": reverse(">"); break;
                  case "<=": reverse(">="); break;
                }
            }
        }
        if (self.operator == "+" && self.right instanceof AST_String
            && self.right.getValue() === "" && self.left instanceof AST_Binary
            && self.left.operator == "+" && self.left.is_string(compressor)) {
            return self.left;
        }
        if (compressor.option("evaluate")) {
            switch (self.operator) {
              case "&&":
                if (self.left.is_constant()) {
                    if (self.left.constant_value(compressor)) {
                        compressor.warn("Condition left of && always true [{file}:{line},{col}]", self.start);
                        return maintain_this_binding(compressor.parent(), self, self.right);
                    } else {
                        compressor.warn("Condition left of && always false [{file}:{line},{col}]", self.start);
                        return maintain_this_binding(compressor.parent(), self, self.left);
                    }
                }
                break;
              case "||":
                if (self.left.is_constant()) {
                    if (self.left.constant_value(compressor)) {
                        compressor.warn("Condition left of || always true [{file}:{line},{col}]", self.start);
                        return maintain_this_binding(compressor.parent(), self, self.left);
                    } else {
                        compressor.warn("Condition left of || always false [{file}:{line},{col}]", self.start);
                        return maintain_this_binding(compressor.parent(), self, self.right);
                    }
                }
                break;
            }
            if (self.operator == "+") {
                if (self.left instanceof AST_Constant
                    && self.right instanceof AST_Binary
                    && self.right.operator == "+"
                    && self.right.left instanceof AST_Constant
                    && self.right.is_string(compressor)) {
                    self = make_node(AST_Binary, self, {
                        operator: "+",
                        left: make_node(AST_String, null, {
                            value: "" + self.left.getValue() + self.right.left.getValue(),
                            start: self.left.start,
                            end: self.right.left.end
                        }),
                        right: self.right.right
                    });
                }
                if (self.right instanceof AST_Constant
                    && self.left instanceof AST_Binary
                    && self.left.operator == "+"
                    && self.left.right instanceof AST_Constant
                    && self.left.is_string(compressor)) {
                    self = make_node(AST_Binary, self, {
                        operator: "+",
                        left: self.left.left,
                        right: make_node(AST_String, null, {
                            value: "" + self.left.right.getValue() + self.right.getValue(),
                            start: self.left.right.start,
                            end: self.right.end
                        })
                    });
                }
                if (self.left instanceof AST_Binary
                    && self.left.operator == "+"
                    && self.left.is_string(compressor)
                    && self.left.right instanceof AST_Constant
                    && self.right instanceof AST_Binary
                    && self.right.operator == "+"
                    && self.right.left instanceof AST_Constant
                    && self.right.is_string(compressor)) {
                    self = make_node(AST_Binary, self, {
                        operator: "+",
                        left: make_node(AST_Binary, self.left, {
                            operator: "+",
                            left: self.left.left,
                            right: make_node(AST_String, null, {
                                value: "" + self.left.right.getValue() + self.right.left.getValue(),
                                start: self.left.right.start,
                                end: self.right.left.end
                            })
                        }),
                        right: self.right.right
                    });
                }
            }
        }
        // x && (y && z)  ==>  x && y && z
        // x || (y || z)  ==>  x || y || z
        // x + ("y" + z)  ==>  x + "y" + z
        // "x" + (y + "z")==>  "x" + y + "z"
        if (self.right instanceof AST_Binary
            && self.right.operator == self.operator
            && (self.operator == "&&"
                || self.operator == "||"
                || (self.operator == "+"
                    && (self.right.left.is_string(compressor)
                        || (self.left.is_string(compressor)
                            && self.right.right.is_string(compressor))))))
        {
            self.left = make_node(AST_Binary, self.left, {
                operator : self.operator,
                left     : self.left,
                right    : self.right.left
            });
            self.right = self.right.right;
            return self.transform(compressor);
        }
        return self.evaluate(compressor)[0];
    });

    OPT(AST_SymbolRef, function(self, compressor){
        var def = self.resolve_defines(compressor);
        if (def) {
            return def;
        }
        // testing against !self.scope.uses_with first is an optimization
        if (self.undeclared() && !isLHS(self, compressor.parent())
            && (!self.scope.uses_with || !compressor.find_parent(AST_With))) {
            switch (self.name) {
              case "undefined":
                return make_node(AST_Undefined, self);
              case "NaN":
                return make_node(AST_NaN, self).transform(compressor);
              case "Infinity":
                return make_node(AST_Infinity, self).transform(compressor);
            }
        }
        if (compressor.option("evaluate") && compressor.option("reduce_vars")) {
            var d = self.definition();
            if (d.fixed && d.init) {
                if (d.should_replace === undefined) {
                    var init = d.init.evaluate(compressor);
                    if (init.length > 1) {
                        var value = init[0].print_to_string().length;
                        var name = d.name.length;
                        var freq = d.references.length;
                        var overhead = d.global || !freq ? 0 : (name + 2 + value) / freq;
                        d.should_replace = value <= name + overhead ? init[0] : false;
                    } else {
                        d.should_replace = false;
                    }
                }
                if (d.should_replace) {
                    return d.should_replace;
                }
            }
        }
        return self;
    });

    OPT(AST_Infinity, function (self, compressor) {
        return make_node(AST_Binary, self, {
            operator : '/',
            left     : make_node(AST_Number, self, {value: 1}),
            right    : make_node(AST_Number, self, {value: 0})
        });
    });

    OPT(AST_Undefined, function(self, compressor){
        if (compressor.option("unsafe")) {
            var scope = compressor.find_parent(AST_Scope);
            var undef = scope.find_variable("undefined");
            if (undef) {
                return make_node(AST_SymbolRef, self, {
                    name   : "undefined",
                    scope  : scope,
                    thedef : undef
                });
            }
        }
        return self;
    });

    var ASSIGN_OPS = [ '+', '-', '/', '*', '%', '>>', '<<', '>>>', '|', '^', '&' ];
    var ASSIGN_OPS_COMMUTATIVE = [ '*', '|', '^', '&' ];
    OPT(AST_Assign, function(self, compressor){
        self = self.lift_sequences(compressor);
        if (self.operator == "=" && self.left instanceof AST_SymbolRef && self.right instanceof AST_Binary) {
            // x = expr1 OP expr2
            if (self.right.left instanceof AST_SymbolRef
                && self.right.left.name == self.left.name
                && member(self.right.operator, ASSIGN_OPS)) {
                // x = x - 2  --->  x -= 2
                self.operator = self.right.operator + "=";
                self.right = self.right.right;
            }
            else if (self.right.right instanceof AST_SymbolRef
                && self.right.right.name == self.left.name
                && member(self.right.operator, ASSIGN_OPS_COMMUTATIVE)
                && !self.right.left.has_side_effects(compressor)) {
                // x = 2 & x  --->  x &= 2
                self.operator = self.right.operator + "=";
                self.right = self.right.left;
            }
        }
        return self;
    });

    OPT(AST_Conditional, function(self, compressor){
        if (!compressor.option("conditionals")) return self;
        if (self.condition instanceof AST_Seq) {
            var car = self.condition.car;
            self.condition = self.condition.cdr;
            return AST_Seq.cons(car, self);
        }
        var cond = self.condition.evaluate(compressor);
        if (cond.length > 1) {
            if (cond[1]) {
                compressor.warn("Condition always true [{file}:{line},{col}]", self.start);
                return maintain_this_binding(compressor.parent(), self, self.consequent);
            } else {
                compressor.warn("Condition always false [{file}:{line},{col}]", self.start);
                return maintain_this_binding(compressor.parent(), self, self.alternative);
            }
        }
        var statement = first_in_statement(compressor);
        var negated = cond[0].negate(compressor, statement);
        if ((statement ? best_of_statement : best_of)(cond[0], negated) === negated) {
            self = make_node(AST_Conditional, self, {
                condition: negated,
                consequent: self.alternative,
                alternative: self.consequent
            });
        }
        var consequent = self.consequent;
        var alternative = self.alternative;
        if (consequent instanceof AST_Assign
            && alternative instanceof AST_Assign
            && consequent.operator == alternative.operator
            && consequent.left.equivalent_to(alternative.left)
            && (!consequent.left.has_side_effects(compressor)
                || !self.condition.has_side_effects(compressor))
           ) {
            /*
             * Stuff like this:
             * if (foo) exp = something; else exp = something_else;
             * ==>
             * exp = foo ? something : something_else;
             */
            return make_node(AST_Assign, self, {
                operator: consequent.operator,
                left: consequent.left,
                right: make_node(AST_Conditional, self, {
                    condition: self.condition,
                    consequent: consequent.right,
                    alternative: alternative.right
                })
            });
        }
        // x ? y(a) : y(b) --> y(x ? a : b)
        if (consequent instanceof AST_Call
            && alternative.TYPE === consequent.TYPE
            && consequent.args.length == 1
            && alternative.args.length == 1
            && consequent.expression.equivalent_to(alternative.expression)
            && !consequent.expression.has_side_effects(compressor)) {
            consequent.args[0] = make_node(AST_Conditional, self, {
                condition: self.condition,
                consequent: consequent.args[0],
                alternative: alternative.args[0]
            });
            return consequent;
        }
        // x?y?z:a:a --> x&&y?z:a
        if (consequent instanceof AST_Conditional
            && consequent.alternative.equivalent_to(alternative)) {
            return make_node(AST_Conditional, self, {
                condition: make_node(AST_Binary, self, {
                    left: self.condition,
                    operator: "&&",
                    right: consequent.condition
                }),
                consequent: consequent.consequent,
                alternative: alternative
            });
        }
        // x ? y : y --> x, y
        if (consequent.equivalent_to(alternative)) {
            return make_node(AST_Seq, self, {
                car: self.condition,
                cdr: consequent
            }).optimize(compressor);
        }

        if (is_true(self.consequent)) {
            if (is_false(self.alternative)) {
                // c ? true : false ---> !!c
                return booleanize(self.condition);
            }
            // c ? true : x ---> !!c || x
            return make_node(AST_Binary, self, {
                operator: "||",
                left: booleanize(self.condition),
                right: self.alternative
            });
        }
        if (is_false(self.consequent)) {
            if (is_true(self.alternative)) {
                // c ? false : true ---> !c
                return booleanize(self.condition.negate(compressor));
            }
            // c ? false : x ---> !c && x
            return make_node(AST_Binary, self, {
                operator: "&&",
                left: booleanize(self.condition.negate(compressor)),
                right: self.alternative
            });
        }
        if (is_true(self.alternative)) {
            // c ? x : true ---> !c || x
            return make_node(AST_Binary, self, {
                operator: "||",
                left: booleanize(self.condition.negate(compressor)),
                right: self.consequent
            });
        }
        if (is_false(self.alternative)) {
            // c ? x : false ---> !!c && x
            return make_node(AST_Binary, self, {
                operator: "&&",
                left: booleanize(self.condition),
                right: self.consequent
            });
        }

        return self;

        function booleanize(node) {
            if (node.is_boolean()) return node;
            // !!expression
            return make_node(AST_UnaryPrefix, node, {
                operator: "!",
                expression: node.negate(compressor)
            });
        }

        // AST_True or !0
        function is_true(node) {
            return node instanceof AST_True
                || (node instanceof AST_UnaryPrefix
                    && node.operator == "!"
                    && node.expression instanceof AST_Constant
                    && !node.expression.value);
        }
        // AST_False or !1
        function is_false(node) {
            return node instanceof AST_False
                || (node instanceof AST_UnaryPrefix
                    && node.operator == "!"
                    && node.expression instanceof AST_Constant
                    && !!node.expression.value);
        }
    });

    OPT(AST_Boolean, function(self, compressor){
        if (compressor.option("booleans")) {
            var p = compressor.parent();
            if (p instanceof AST_Binary && (p.operator == "=="
                                            || p.operator == "!=")) {
                compressor.warn("Non-strict equality against boolean: {operator} {value} [{file}:{line},{col}]", {
                    operator : p.operator,
                    value    : self.value,
                    file     : p.start.file,
                    line     : p.start.line,
                    col      : p.start.col,
                });
                return make_node(AST_Number, self, {
                    value: +self.value
                });
            }
            return make_node(AST_UnaryPrefix, self, {
                operator: "!",
                expression: make_node(AST_Number, self, {
                    value: 1 - self.value
                })
            });
        }
        return self;
    });

    OPT(AST_Sub, function(self, compressor){
        var prop = self.property;
        if (prop instanceof AST_String && compressor.option("properties")) {
            prop = prop.getValue();
            if (RESERVED_WORDS(prop) ? compressor.option("screw_ie8") : is_identifier_string(prop)) {
                return make_node(AST_Dot, self, {
                    expression : self.expression,
                    property   : prop
                }).optimize(compressor);
            }
            var v = parseFloat(prop);
            if (!isNaN(v) && v.toString() == prop) {
                self.property = make_node(AST_Number, self.property, {
                    value: v
                });
            }
        }
        return self.evaluate(compressor)[0];
    });

    OPT(AST_Dot, function(self, compressor){
        var def = self.resolve_defines(compressor);
        if (def) {
            return def;
        }
        var prop = self.property;
        if (RESERVED_WORDS(prop) && !compressor.option("screw_ie8")) {
            return make_node(AST_Sub, self, {
                expression : self.expression,
                property   : make_node(AST_String, self, {
                    value: prop
                })
            }).optimize(compressor);
        }
        if (compressor.option("unsafe_proto")
            && self.expression instanceof AST_Dot
            && self.expression.property == "prototype") {
            var exp = self.expression.expression;
            if (exp instanceof AST_SymbolRef && exp.undeclared()) switch (exp.name) {
              case "Array":
                self.expression = make_node(AST_Array, self.expression, {
                    elements: []
                });
                break;
              case "Object":
                self.expression = make_node(AST_Object, self.expression, {
                    properties: []
                });
                break;
              case "String":
                self.expression = make_node(AST_String, self.expression, {
                    value: ""
                });
                break;
            }
        }
        return self.evaluate(compressor)[0];
    });

    function literals_in_boolean_context(self, compressor) {
        if (compressor.option("booleans") && compressor.in_boolean_context()) {
            var best = first_in_statement(compressor) ? best_of_statement : best_of;
            return best(self, make_node(AST_Seq, self, {
                car: self,
                cdr: make_node(AST_True, self)
            }).optimize(compressor));
        }
        return self;
    };
    OPT(AST_Array, literals_in_boolean_context);
    OPT(AST_Object, literals_in_boolean_context);
    OPT(AST_RegExp, literals_in_boolean_context);

    OPT(AST_Return, function(self, compressor){
        if (self.value instanceof AST_Undefined) {
            self.value = null;
        }
        return self;
    });

    OPT(AST_VarDef, function(self, compressor){
        var defines = compressor.option("global_defs");
        if (defines && HOP(defines, self.name.name)) {
            compressor.warn('global_defs ' + self.name.name + ' redefined [{file}:{line},{col}]', self.start);
        }
        return self;
    });

})();
