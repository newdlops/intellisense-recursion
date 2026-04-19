//! Symbol extraction via tree-sitter AST walk. Dispatches by file extension
//! to language-specific parsers (currently Python and TypeScript).

use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use crate::format::Kind;

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: Kind,
    /// 1-indexed
    pub line: u32,
    /// 1-indexed
    pub col: u32,
}

/// Language dispatcher; picks a parser by file extension.
pub enum LangParser {
    Python(PythonParser),
    TypeScript(TypeScriptParser),
}

impl LangParser {
    pub fn for_extension(ext: &str) -> Option<Self> {
        match ext {
            "py" | "pyi" => Some(Self::Python(PythonParser::new().ok()?)),
            // LANGUAGE_TYPESCRIPT handles .ts and .d.ts
            "ts" => Some(Self::TypeScript(TypeScriptParser::new(false).ok()?)),
            "tsx" => Some(Self::TypeScript(TypeScriptParser::new(true).ok()?)),
            _ => None,
        }
    }

    pub fn parse(&mut self, source: &[u8]) -> Result<Vec<Symbol>> {
        match self {
            Self::Python(p) => p.parse(source),
            Self::TypeScript(p) => p.parse(source),
        }
    }
}

// ───────────────────────────────────────── Python ─────────────────────────────

pub struct PythonParser {
    parser: Parser,
}

impl PythonParser {
    pub fn new() -> Result<Self> {
        let mut parser = Parser::new();
        let language = tree_sitter_python::language();
        parser
            .set_language(&language)
            .context("failed to set tree-sitter Python language")?;
        Ok(Self { parser })
    }

    pub fn parse(&mut self, source: &[u8]) -> Result<Vec<Symbol>> {
        let tree = self
            .parser
            .parse(source, None)
            .context("tree-sitter returned no tree")?;
        let mut out = Vec::with_capacity(64);
        let root = tree.root_node();
        py::walk_children(root, source, py::Scope::Module, &mut out);
        Ok(out)
    }
}

mod py {
    use super::{push, Kind, Symbol};
    use tree_sitter::Node;

    #[derive(Copy, Clone, PartialEq, Eq, Debug)]
    pub enum Scope {
        Module,
        Class,
        Function,
    }

    pub fn walk_children(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            visit(child, source, scope, out);
        }
    }

    fn visit(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        match node.kind() {
            "class_definition" => handle_class(node, source, out),
            "function_definition" => handle_function(node, source, scope, false, out),
            "decorated_definition" => handle_decorated(node, source, scope, out),
            "assignment" => handle_assignment(node, source, scope, out),
            "expression_statement" => walk_children(node, source, scope, out),
            "import_statement" => handle_import(node, source, out),
            "import_from_statement" => handle_import_from(node, source, out),
            "if_statement" | "else_clause" | "elif_clause" | "try_statement"
            | "except_clause" | "finally_clause" | "with_statement" | "for_statement"
            | "while_statement" | "match_statement" | "case_clause" | "block" => {
                walk_children(node, source, scope, out);
            }
            _ => {}
        }
    }

    fn handle_class(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        if let Some(name) = node.child_by_field_name("name") {
            push(name, Kind::Class, source, out);
        }
        if let Some(body) = node.child_by_field_name("body") {
            walk_children(body, source, Scope::Class, out);
        }
    }

    fn handle_function(
        node: Node,
        source: &[u8],
        scope: Scope,
        _is_property: bool,
        out: &mut Vec<Symbol>,
    ) {
        let fn_name_node = node.child_by_field_name("name");
        let fn_name = fn_name_node.and_then(|n| n.utf8_text(source).ok()).unwrap_or("");

        if let Some(name) = fn_name_node {
            let kind = match scope {
                Scope::Class => Kind::Method,
                _ => Kind::Function,
            };
            push(name, kind, source, out);
        }

        if scope == Scope::Class && fn_name == "__init__" {
            if let Some(body) = node.child_by_field_name("body") {
                collect_self_attrs(body, source, out);
            }
        }

        if let Some(body) = node.child_by_field_name("body") {
            walk_children(body, source, Scope::Function, out);
        }
    }

    fn handle_decorated(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        let mut is_property = false;
        let mut cur = node.walk();
        for child in node.children(&mut cur) {
            if child.kind() == "decorator" {
                if let Ok(text) = child.utf8_text(source) {
                    let t = text.trim_start_matches('@').trim();
                    if t == "property" || t.ends_with(".property") {
                        is_property = true;
                    }
                }
            }
        }
        if let Some(def) = node.child_by_field_name("definition") {
            match def.kind() {
                "class_definition" => handle_class(def, source, out),
                "function_definition" => handle_function(def, source, scope, is_property, out),
                _ => {}
            }
        } else {
            let mut cur = node.walk();
            for child in node.children(&mut cur) {
                match child.kind() {
                    "class_definition" => handle_class(child, source, out),
                    "function_definition" => {
                        handle_function(child, source, scope, is_property, out)
                    }
                    _ => {}
                }
            }
        }
    }

    fn handle_assignment(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        if matches!(scope, Scope::Function) {
            return;
        }
        if let Some(left) = node.child_by_field_name("left") {
            collect_lhs(left, source, scope, out);
        }
    }

    fn collect_lhs(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        match node.kind() {
            "identifier" => {
                let kind = match scope {
                    Scope::Class => Kind::Attribute,
                    _ => Kind::Variable,
                };
                push(node, kind, source, out);
            }
            "pattern_list" | "tuple_pattern" | "list_pattern" | "expression_list"
            | "list_splat_pattern" => {
                let mut cur = node.walk();
                for child in node.named_children(&mut cur) {
                    collect_lhs(child, source, scope, out);
                }
            }
            _ => {}
        }
    }

    fn collect_self_attrs(body: Node, source: &[u8], out: &mut Vec<Symbol>) {
        fn visit_inner(n: Node, source: &[u8], out: &mut Vec<Symbol>) {
            match n.kind() {
                "function_definition" | "class_definition" => return,
                "assignment" => {
                    if let Some(lhs) = n.child_by_field_name("left") {
                        emit_self_dot(lhs, source, out);
                    }
                }
                _ => {}
            }
            let mut cur = n.walk();
            for child in n.children(&mut cur) {
                visit_inner(child, source, out);
            }
        }

        fn emit_self_dot(lhs: Node, source: &[u8], out: &mut Vec<Symbol>) {
            match lhs.kind() {
                "attribute" => {
                    let obj = lhs.child_by_field_name("object");
                    let attr = lhs.child_by_field_name("attribute");
                    if let (Some(obj), Some(attr)) = (obj, attr) {
                        if obj.utf8_text(source).map(|t| t == "self").unwrap_or(false) {
                            push(attr, Kind::Attribute, source, out);
                        }
                    }
                }
                "pattern_list" | "tuple_pattern" | "list_pattern" | "expression_list" => {
                    let mut cur = lhs.walk();
                    for child in lhs.named_children(&mut cur) {
                        emit_self_dot(child, source, out);
                    }
                }
                _ => {}
            }
        }

        visit_inner(body, source, out);
    }

    fn handle_import(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        let mut cur = node.walk();
        for child in node.named_children(&mut cur) {
            match child.kind() {
                "dotted_name" => {
                    if let Some(first) = child.named_child(0) {
                        if first.kind() == "identifier" {
                            push(first, Kind::Alias, source, out);
                        }
                    }
                }
                "aliased_import" => {
                    if let Some(alias) = child.child_by_field_name("alias") {
                        push(alias, Kind::Alias, source, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn handle_import_from(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        let module_name = node.child_by_field_name("module_name");
        let mut cur = node.walk();
        for child in node.named_children(&mut cur) {
            if let Some(m) = module_name {
                if child.id() == m.id() {
                    continue;
                }
            }
            match child.kind() {
                "dotted_name" => {
                    if let Some(last) =
                        child.named_child(child.named_child_count().saturating_sub(1))
                    {
                        if last.kind() == "identifier" {
                            push(last, Kind::Alias, source, out);
                        }
                    }
                }
                "aliased_import" => {
                    if let Some(alias) = child.child_by_field_name("alias") {
                        push(alias, Kind::Alias, source, out);
                    }
                }
                _ => {}
            }
        }
    }
}

// ───────────────────────────────────────── TypeScript ─────────────────────────

pub struct TypeScriptParser {
    parser: Parser,
}

impl TypeScriptParser {
    pub fn new(tsx: bool) -> Result<Self> {
        let mut parser = Parser::new();
        let language = if tsx {
            tree_sitter_typescript::language_tsx()
        } else {
            tree_sitter_typescript::language_typescript()
        };
        parser
            .set_language(&language)
            .context("failed to set tree-sitter TypeScript language")?;
        Ok(Self { parser })
    }

    pub fn parse(&mut self, source: &[u8]) -> Result<Vec<Symbol>> {
        let tree = self
            .parser
            .parse(source, None)
            .context("tree-sitter returned no tree")?;
        let mut out = Vec::with_capacity(64);
        let root = tree.root_node();
        ts::walk_children(root, source, ts::Scope::Module, &mut out);
        Ok(out)
    }
}

mod ts {
    use super::{push, Kind, Symbol};
    use tree_sitter::Node;

    #[derive(Copy, Clone, PartialEq, Eq, Debug)]
    pub enum Scope {
        Module,
        Class,
    }

    pub fn walk_children(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            visit(child, source, scope, out);
        }
    }

    fn visit(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        match node.kind() {
            // Class-like declarations
            "class_declaration" | "abstract_class_declaration" | "interface_declaration" => {
                handle_class_like(node, source, out);
            }
            "enum_declaration" => handle_enum(node, source, out),
            // Type aliases: `type X = ...` → indexed as Variable (module-level).
            "type_alias_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    push(name, Kind::Variable, source, out);
                }
            }
            // Functions.
            "function_declaration" | "generator_function_declaration" => {
                if let Some(name) = node.child_by_field_name("name") {
                    let kind = match scope {
                        Scope::Class => Kind::Method,
                        _ => Kind::Function,
                    };
                    push(name, kind, source, out);
                }
                // Function body: skip (we don't index local declarations).
            }
            // Class / interface members (only meaningful in class scope).
            "method_definition"
            | "method_signature"
            | "abstract_method_signature"
            | "function_signature" => {
                if scope == Scope::Class {
                    if let Some(name) = node.child_by_field_name("name") {
                        push(name, Kind::Method, source, out);
                    }
                }
            }
            "public_field_definition" | "property_signature" => {
                if scope == Scope::Class {
                    if let Some(name) = node.child_by_field_name("name") {
                        push(name, Kind::Attribute, source, out);
                    }
                }
            }
            // var/let/const at module level.
            "lexical_declaration" | "variable_declaration" => {
                handle_var_declaration(node, source, scope, out);
            }
            // Wrappers that don't introduce a new scope from our perspective.
            "export_statement" | "ambient_declaration" | "export_assignment" => {
                walk_children(node, source, scope, out);
            }
            // `declare module "foo" { ... }` / `namespace X { ... }`.
            "module_declaration" | "internal_module" => {
                if let Some(name) = node.child_by_field_name("name") {
                    if matches!(name.kind(), "identifier" | "type_identifier" | "nested_identifier") {
                        push(name, Kind::Class, source, out);
                    }
                }
                if let Some(body) = node.child_by_field_name("body") {
                    walk_children(body, source, Scope::Module, out);
                }
            }
            // Import statements bind names into scope (treated as aliases,
            // mirroring Python).
            "import_statement" => handle_import(node, source, out),
            // Recurse into containers that don't define their own scope.
            "class_body" | "object_type" | "statement_block" => {
                let inner_scope = if matches!(node.kind(), "class_body" | "object_type") {
                    Scope::Class
                } else {
                    scope
                };
                walk_children(node, source, inner_scope, out);
            }
            _ => {}
        }
    }

    fn handle_class_like(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        if let Some(name) = node.child_by_field_name("name") {
            push(name, Kind::Class, source, out);
        }
        if let Some(body) = node.child_by_field_name("body") {
            walk_children(body, source, Scope::Class, out);
        }
    }

    fn handle_enum(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        if let Some(name) = node.child_by_field_name("name") {
            push(name, Kind::Class, source, out);
        }
        // Enum body contains property_identifier (bare) or enum_assignment.
        if let Some(body) = node.child_by_field_name("body") {
            let mut cur = body.walk();
            for child in body.named_children(&mut cur) {
                match child.kind() {
                    "property_identifier" => push(child, Kind::Attribute, source, out),
                    "enum_assignment" => {
                        if let Some(n) = child.child_by_field_name("name") {
                            push(n, Kind::Attribute, source, out);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn handle_var_declaration(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        let mut cur = node.walk();
        for child in node.named_children(&mut cur) {
            if child.kind() == "variable_declarator" {
                if let Some(name) = child.child_by_field_name("name") {
                    collect_lhs(name, source, scope, out);
                }
            }
        }
    }

    fn collect_lhs(node: Node, source: &[u8], scope: Scope, out: &mut Vec<Symbol>) {
        match node.kind() {
            "identifier" | "type_identifier" => {
                let kind = match scope {
                    Scope::Class => Kind::Attribute,
                    _ => Kind::Variable,
                };
                push(node, kind, source, out);
            }
            "array_pattern" | "object_pattern" => {
                let mut cur = node.walk();
                for child in node.named_children(&mut cur) {
                    collect_lhs(child, source, scope, out);
                }
            }
            "shorthand_property_identifier_pattern" => {
                push(node, Kind::Variable, source, out);
            }
            "pair_pattern" => {
                if let Some(value) = node.child_by_field_name("value") {
                    collect_lhs(value, source, scope, out);
                }
            }
            _ => {}
        }
    }

    fn handle_import(node: Node, source: &[u8], out: &mut Vec<Symbol>) {
        // `import X from "..."`, `import { A, B as C } from "..."`,
        // `import * as ns from "..."`
        let mut cur = node.walk();
        for child in node.named_children(&mut cur) {
            match child.kind() {
                "import_clause" => {
                    let mut cc = child.walk();
                    for sub in child.named_children(&mut cc) {
                        match sub.kind() {
                            // default import
                            "identifier" => push(sub, Kind::Alias, source, out),
                            "namespace_import" => {
                                // `* as NS`
                                if let Some(alias) = sub.child_by_field_name("alias") {
                                    push(alias, Kind::Alias, source, out);
                                }
                            }
                            "named_imports" => {
                                let mut cc2 = sub.walk();
                                for spec in sub.named_children(&mut cc2) {
                                    if spec.kind() == "import_specifier" {
                                        // prefer alias, fall back to name
                                        if let Some(alias) = spec.child_by_field_name("alias") {
                                            push(alias, Kind::Alias, source, out);
                                        } else if let Some(name) =
                                            spec.child_by_field_name("name")
                                        {
                                            push(name, Kind::Alias, source, out);
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

// ──────────────────────── shared helper ────────────────────────

fn push(name: Node, kind: Kind, source: &[u8], out: &mut Vec<Symbol>) {
    if let Ok(text) = name.utf8_text(source) {
        if text.is_empty() {
            return;
        }
        let start = name.start_position();
        out.push(Symbol {
            name: text.to_string(),
            kind,
            line: (start.row as u32) + 1,
            col: (start.column as u32) + 1,
        });
    }
}
