//! Pure graph model for JellyLint (`nodes + graph`).

mod builder;
mod data;
mod error;
mod overlap;
mod query;

pub use builder::build_graph;
pub use data::{
    EdgeCheckDetail, EdgeCheckResult, EdgeSeverity, GraphSpec, NodeRef, ResolvedGraph, RuleScope,
    RuleSpec,
};
pub use query::collect_source_roots;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use serde_json::json;

    use super::*;

    #[test]
    fn same_variable_name_is_bound_for_connect() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@feature:[feat]:db".to_string(),
                vec!["src/features/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([(
                    "@feature:[feat]:ui".to_string(),
                    vec!["@feature:[feat]:db".to_string()],
                )]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");

        let from = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/ui/a.ts"))
            .expect("from node");
        let to_same = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/db/b.ts"))
            .expect("to same");
        let to_other = g
            .resolve_file_node(cwd, &cwd.join("src/features/user/db/c.ts"))
            .expect("to other");
        assert!(g.has_edge(&from, &to_same));
        assert!(!g.has_edge(&from, &to_other));
    }

    #[test]
    fn npm_external_is_resolved_as_graph_node() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([("@ext:react".to_string(), vec!["npm:react".to_string()])]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        assert!(g.resolve_target_node(cwd, "react", None).is_some());
        assert!(g.resolve_target_node(cwd, "react/jsx-runtime", None).is_some());
    }

    #[test]
    fn node_can_match_file_and_directory_forms() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([(
            "@page:[page]".to_string(),
            vec![
                "src/pages/[page].*".to_string(),
                "src/pages/[page]/**/*".to_string(),
            ],
        )]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        let flat = g
            .resolve_file_node(cwd, &cwd.join("src/pages/DetailPage.tsx"))
            .expect("flat page");
        let nested = g
            .resolve_file_node(cwd, &cwd.join("src/pages/JellypulsePage/index.tsx"))
            .expect("nested page");
        assert_eq!(flat.concrete_id, "@page:DetailPage");
        assert_eq!(nested.concrete_id, "@page:JellypulsePage");
    }

    #[test]
    fn graph_selector_supports_namespace_aggregate() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@feature:a".to_string(), vec!["src/feature/a/**/*".to_string()]),
            ("@core:engine".to_string(), vec!["src/core/engine/**/*".to_string()]),
            ("@core:shared".to_string(), vec!["src/core/shared/**/*".to_string()]),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([("@feature:a".to_string(), vec!["@core:**".to_string()])]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        let from = g
            .resolve_file_node(cwd, &cwd.join("src/feature/a/index.ts"))
            .expect("from node");
        let to_engine = g
            .resolve_file_node(cwd, &cwd.join("src/core/engine/index.ts"))
            .expect("to engine");
        let to_shared = g
            .resolve_file_node(cwd, &cwd.join("src/core/shared/index.ts"))
            .expect("to shared");
        assert!(g.has_edge(&from, &to_engine));
        assert!(g.has_edge(&from, &to_shared));
    }

    /// Rule uses `[feat]` on both sides: warn when a feature imports another feature's service (cross-feat).
    #[test]
    fn rules_cross_edge_placeholder_injection() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@service:[feat]".to_string(),
                vec!["src/services/[feat]/**/*".to_string()],
            ),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([(
                    "@feature:[feat]:ui".to_string(),
                    vec!["@service:[feat]".to_string()],
                )]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": "@feature:[feat]:ui",
                "to": "!@service:[feat]"
            },
            "severity": "warn",
            "message": "cross-feature service"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");

        let from_auth = g
            .resolve_file_node(cwd, &cwd.join("src/features/auth/ui/a.ts"))
            .expect("from auth ui");
        let to_same_feat_svc = g
            .resolve_file_node(cwd, &cwd.join("src/services/auth/index.ts"))
            .expect("auth service");
        let to_other_svc = g
            .resolve_file_node(cwd, &cwd.join("src/services/user/index.ts"))
            .expect("user service");

        assert_eq!(
            g.check_edge_with_context(
                &from_auth,
                &to_same_feat_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/auth/index.ts"),
                None,
            ),
            EdgeCheckResult::Allowed
        );
        assert_eq!(
            g.check_edge_with_context(
                &from_auth,
                &to_other_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/user/index.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("cross-feature service".to_string())
        );
    }

    /// `scope: "fallback"`: warn only when topology rejects (cross-feat service), not on deps to other nodes like `@tools`.
    #[test]
    fn rules_warn_cross_service_only_when_topology_rejects() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@service:[feat]".to_string(),
                vec!["src/services/[feat]/**/*".to_string()],
            ),
            ("@tools".to_string(), vec!["src/tools/**/*".to_string()]),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([(
                    "@feature:[feat]:ui".to_string(),
                    vec!["@service:[feat]".to_string(), "@tools".to_string()],
                )]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": "@feature:*:ui",
                "to": "@service:*"
            },
            "scope": "fallback",
            "severity": "warn",
            "message": "cross-feature service access is a legacy debt"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");

        let from_auth = g
            .resolve_file_node(cwd, &cwd.join("src/features/auth/ui/a.ts"))
            .expect("from auth ui");
        let to_same_feat_svc = g
            .resolve_file_node(cwd, &cwd.join("src/services/auth/index.ts"))
            .expect("auth service");
        let to_other_svc = g
            .resolve_file_node(cwd, &cwd.join("src/services/user/index.ts"))
            .expect("user service");
        let to_tools = g
            .resolve_file_node(cwd, &cwd.join("src/tools/format.ts"))
            .expect("tools");

        assert_eq!(
            g.check_edge_with_context(
                &from_auth,
                &to_same_feat_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/auth/index.ts"),
                None,
            ),
            EdgeCheckResult::Allowed
        );
        assert_eq!(
            g.check_edge_with_context(
                &from_auth,
                &to_other_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/user/index.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("cross-feature service access is a legacy debt".to_string())
        );
        assert_eq!(
            g.check_edge_with_context(
                &from_auth,
                &to_tools,
                Some("src/features/auth/ui/a.ts"),
                Some("src/tools/format.ts"),
                None,
            ),
            EdgeCheckResult::Allowed
        );
    }

    #[test]
    fn rules_can_downgrade_forbidden_edge_to_warn() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@legacy:[feat]:db".to_string(),
                vec!["src/legacy/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": { "from": "@feature:*", "to": "@legacy:*" },
            "severity": "warn",
            "message": "legacy debt"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");
        let from = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/ui/index.ts"))
            .expect("from");
        let to = g
            .resolve_file_node(cwd, &cwd.join("src/legacy/order/db/index.ts"))
            .expect("to");
        assert_eq!(
            g.check_edge_with_context(
                &from,
                &to,
                Some("src/features/order/ui/index.ts"),
                Some("src/legacy/order/db/index.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("legacy debt".to_string())
        );
    }

    /// First matching rule wins; later rules are ignored (ordered governance).
    #[test]
    fn rules_first_match_wins_over_later_rules() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@legacy:[feat]:db".to_string(),
                vec!["src/legacy/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let rules = vec![
            serde_json::from_value::<RuleSpec>(json!({
                "match": { "from": "@feature:*", "to": "@legacy:*" },
                "severity": "warn",
                "message": "first wins"
            }))
            .expect("rule parse"),
            serde_json::from_value::<RuleSpec>(json!({
                "match": { "from": "@feature:*", "to": "@legacy:*" },
                "severity": "off",
                "message": "skipped"
            }))
            .expect("rule parse"),
        ];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");
        let from = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/ui/index.ts"))
            .expect("from");
        let to = g
            .resolve_file_node(cwd, &cwd.join("src/legacy/order/db/index.ts"))
            .expect("to");
        assert_eq!(
            g.check_edge_with_context(
                &from,
                &to,
                Some("src/features/order/ui/index.ts"),
                Some("src/legacy/order/db/index.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("first wins".to_string())
        );
    }

    /// `severity: "error"` forbids even when the abstract graph allows the edge (hard gate).
    #[test]
    fn rules_severity_error_forbids_when_topology_would_allow() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@feature:[feat]:db".to_string(),
                vec!["src/features/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([(
                    "@feature:[feat]:ui".to_string(),
                    vec!["@feature:[feat]:db".to_string()],
                )]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": "@feature:*:ui",
                "to": "@feature:*:db"
            },
            "severity": "error",
            "message": "hard ban"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");
        let from = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/ui/a.ts"))
            .expect("from");
        let to = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/db/x.ts"))
            .expect("to");
        assert_eq!(
            g.check_edge_with_context(
                &from,
                &to,
                Some("src/features/order/ui/a.ts"),
                Some("src/features/order/db/x.ts"),
                None,
            ),
            EdgeCheckResult::Forbidden
        );
    }

    /// `scope: "topology_allowed"`: deprecation-style warn only on edges the graph already allows (same binding); illegal edges stay forbidden without accidental downgrade.
    #[test]
    fn rules_scope_topology_allowed_warns_only_when_graph_allows() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@legacy:[feat]:db".to_string(),
                vec!["src/legacy/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([(
                    "@feature:[feat]:ui".to_string(),
                    vec!["@legacy:[feat]:db".to_string()],
                )]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": { "from": "@feature:*", "to": "@legacy:*" },
            "scope": "topology_allowed",
            "severity": "warn",
            "message": "migrate off legacy"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");

        let from_order = g
            .resolve_file_node(cwd, &cwd.join("src/features/order/ui/index.ts"))
            .expect("from");
        let to_legacy_same = g
            .resolve_file_node(cwd, &cwd.join("src/legacy/order/db/index.ts"))
            .expect("legacy same feat");
        let to_legacy_other = g
            .resolve_file_node(cwd, &cwd.join("src/legacy/other/db/index.ts"))
            .expect("legacy other feat");

        assert_eq!(
            g.check_edge_with_context(
                &from_order,
                &to_legacy_same,
                Some("src/features/order/ui/index.ts"),
                Some("src/legacy/order/db/index.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("migrate off legacy".to_string())
        );
        assert_eq!(
            g.check_edge_with_context(
                &from_order,
                &to_legacy_other,
                Some("src/features/order/ui/index.ts"),
                Some("src/legacy/other/db/index.ts"),
                None,
            ),
            EdgeCheckResult::Forbidden
        );
    }

    #[test]
    fn rules_match_from_positive_arms_follow_json_order_not_glob_first() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@service:[feat]".to_string(),
                vec!["src/services/[feat]/**/*".to_string()],
            ),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);

        let rules_ok = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": ["@feature:[feat]:ui", "@feature:*"],
                "to": "@service:[feat]"
            },
            "severity": "warn",
            "message": "ordered first template binds feat"
        }))
        .expect("rule parse")];
        let g_ok = build_graph(cwd, &nodes, &graphs, rules_ok, "test").expect("build graph");
        let from_ui = g_ok
            .resolve_file_node(cwd, &cwd.join("src/features/auth/ui/a.ts"))
            .expect("from ui");
        let to_svc = g_ok
            .resolve_file_node(cwd, &cwd.join("src/services/auth/x.ts"))
            .expect("to svc");
        assert_eq!(
            g_ok.check_edge_with_context(
                &from_ui,
                &to_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/auth/x.ts"),
                None,
            ),
            EdgeCheckResult::AllowedWithWarn("ordered first template binds feat".to_string())
        );

        let rules_glob_first = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": ["@feature:*", "@feature:[feat]:ui"],
                "to": "@service:[feat]"
            },
            "severity": "warn",
            "message": "glob first skips binding"
        }))
        .expect("rule parse")];
        let g_skip = build_graph(cwd, &nodes, &graphs, rules_glob_first, "test").expect("build graph");
        assert_eq!(
            g_skip.check_edge_with_context(
                &from_ui,
                &to_svc,
                Some("src/features/auth/ui/a.ts"),
                Some("src/services/auth/x.ts"),
                None,
            ),
            EdgeCheckResult::Forbidden
        );
    }

    #[test]
    fn isolated_negation_uses_implicit_universe() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@shared:vfs".to_string(), vec!["src/shared/vfs/**/*".to_string()]),
            ("@feature:a".to_string(), vec!["src/feature/a/**/*".to_string()]),
            ("@ext:fs".to_string(), vec!["node:fs".to_string()]),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([("@shared:vfs".to_string(), vec!["@ext:fs".to_string()])]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "name": "restrict-fs-access",
            "match": { "from": "!@shared:vfs", "to": "node:fs" },
            "severity": "warn",
            "message": "use @shared:vfs"
        }))
        .expect("rule parse")];
        let g = build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");

        let from_feature = g
            .resolve_file_node(cwd, &cwd.join("src/feature/a/index.ts"))
            .expect("feature");
        let from_vfs = g
            .resolve_file_node(cwd, &cwd.join("src/shared/vfs/index.ts"))
            .expect("vfs");
        let to_fs = g
            .resolve_target_node(cwd, "node:fs", None)
            .expect("fs node");

        assert_eq!(
            g.check_edge_with_context(
                &from_feature,
                &to_fs,
                Some("src/feature/a/index.ts"),
                None,
                Some("node:fs"),
            ),
            EdgeCheckResult::AllowedWithWarn("use @shared:vfs".to_string())
        );
        assert_eq!(
            g.check_edge_with_context(
                &from_vfs,
                &to_fs,
                Some("src/shared/vfs/index.ts"),
                None,
                Some("node:fs"),
            ),
            EdgeCheckResult::Allowed
        );
    }

    #[test]
    fn rule_rejects_from_all_negated_with_placeholders() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([("@feature:a".to_string(), vec!["src/a/**/*".to_string()])]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": { "from": "!@feature:[feat]", "to": "@feature:a" },
            "severity": "warn",
        }))
        .expect("rule parse")];
        let err = build_graph(cwd, &nodes, &graphs, rules, "test").expect_err("should reject");
        assert!(err.contains("every pattern is negated"), "{}", err);
    }

    #[test]
    fn rule_rejects_to_placeholder_without_from_capture() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([("@a".to_string(), vec!["src/a/**/*".to_string()])]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);

        let err = build_graph(
            cwd,
            &nodes,
            &graphs,
            vec![serde_json::from_value::<RuleSpec>(json!({
                "match": { "to": "@service:[feat]" },
                "severity": "warn"
            }))
            .expect("rule parse")],
            "test",
        )
        .expect_err("omit from");
        assert!(err.contains("omitted") || err.contains("from"), "{}", err);

        let err2 = build_graph(
            cwd,
            &nodes,
            &graphs,
            vec![serde_json::from_value::<RuleSpec>(json!({
                "match": {
                    "from": "@feature:*",
                    "to": "@service:[feat]"
                },
                "severity": "warn"
            }))
            .expect("rule parse")],
            "test",
        )
        .expect_err("glob-only from");
        assert!(err2.contains("no positive template") || err2.contains("globs"), "{}", err2);

        let err3 = build_graph(
            cwd,
            &nodes,
            &graphs,
            vec![serde_json::from_value::<RuleSpec>(json!({
                "match": {
                    "from": "@feature:[feat]:ui",
                    "to": "@service:[svc]"
                },
                "severity": "warn"
            }))
            .expect("rule parse")],
            "test",
        )
        .expect_err("unknown name on to");
        assert!(err3.contains("svc"), "{}", err3);
    }

    #[test]
    fn rule_allows_from_positive_plus_negated_placeholder_exclude() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@feature:[feat]:ui".to_string(),
                vec!["src/features/[feat]/ui/**/*".to_string()],
            ),
            (
                "@feature:[feat]:db".to_string(),
                vec!["src/features/[feat]/db/**/*".to_string()],
            ),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let rules = vec![serde_json::from_value::<RuleSpec>(json!({
            "match": {
                "from": ["@feature:[feat]:ui", "!@feature:[feat]:db"],
                "to": "@ext:*"
            },
            "severity": "warn",
        }))
        .expect("rule parse")];
        build_graph(cwd, &nodes, &graphs, rules, "test").expect("build graph");
    }

    #[test]
    fn node_internal_patterns_support_exclude() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([(
            "@core:engine".to_string(),
            vec![
                "src/core/engine/**/*".to_string(),
                "!src/core/engine/__tests__/**/*".to_string(),
                "!src/core/engine/**/*.mock.ts".to_string(),
            ],
        )]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");

        assert!(g
            .resolve_file_node(cwd, &cwd.join("src/core/engine/runtime/index.ts"))
            .is_some());
        assert!(g
            .resolve_file_node(cwd, &cwd.join("src/core/engine/__tests__/runtime.test.ts"))
            .is_none());
        assert!(g
            .resolve_file_node(cwd, &cwd.join("src/core/engine/runtime/sample.mock.ts"))
            .is_none());
    }

    #[test]
    fn graph_selector_rejects_negation_syntax() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@a".to_string(), vec!["src/a/**/*".to_string()]),
            ("@b".to_string(), vec!["src/b/**/*".to_string()]),
        ]);
        let graph = GraphSpec {
            cascade: HashMap::new(),
            sequence: HashMap::new(),
            connect: HashMap::from([(
                "default".to_string(),
                HashMap::from([("@a".to_string(), vec!["!@b".to_string()])]),
            )]),
        };
        let graphs = HashMap::from([("default".to_string(), graph)]);
        let err = build_graph(cwd, &nodes, &graphs, vec![], "test").expect_err("should reject");
        assert!(err.contains("does not support negation selector"));
    }

    #[test]
    fn warns_when_node_paths_fully_overlap() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@shared".to_string(), vec!["src/shared/**/*".to_string()]),
            ("@shared:vfs".to_string(), vec!["src/shared/vfs/**/*".to_string()]),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        assert_eq!(g.startup_warnings().len(), 1);
        assert!(g.startup_warnings()[0].contains("overlapping node physical paths"));
    }

    #[test]
    fn overlap_warning_can_be_silenced_with_exclude_boundary() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@shared".to_string(),
                vec!["src/shared/**/*".to_string(), "!src/shared/vfs/**/*".to_string()],
            ),
            ("@shared:vfs".to_string(), vec!["src/shared/vfs/**/*".to_string()]),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        assert_eq!(g.startup_warnings().len(), 0);
    }

    #[test]
    fn test_file_glob_is_not_treated_as_full_superset() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@spec:tests".to_string(), vec!["src/**/*.test.*".to_string()]),
            ("@core:engine".to_string(), vec!["src/core/engine/**/*".to_string()]),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");
        assert_eq!(g.startup_warnings().len(), 0);
    }

    #[test]
    fn node_exclude_can_use_explicit_test_globs() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            (
                "@spec:tests".to_string(),
                vec!["src/**/__tests__/**/*".to_string(), "src/**/*.test.*".to_string()],
            ),
            (
                "@utils".to_string(),
                vec![
                    "src/utils/**/*".to_string(),
                    "!src/**/__tests__/**/*".to_string(),
                    "!src/**/*.test.*".to_string(),
                ],
            ),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let g = build_graph(cwd, &nodes, &graphs, vec![], "test").expect("build graph");

        assert!(g
            .resolve_file_node(cwd, &cwd.join("src/utils/hash/index.ts"))
            .is_some());
        assert_eq!(
            g
            .resolve_file_node(cwd, &cwd.join("src/utils/__tests__/hash.test.ts"))
            .map(|n| n.template_id)
            .as_deref(),
            Some("@spec:tests")
        );
    }

    #[test]
    fn node_pattern_must_not_reference_other_nodes() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([
            ("@a".to_string(), vec!["src/a/**/*".to_string()]),
            ("@b".to_string(), vec!["@a".to_string()]),
        ]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let err = build_graph(cwd, &nodes, &graphs, vec![], "test").expect_err("should fail");
        assert!(err.contains("must not reference other nodes"));
    }

    #[test]
    fn node_pattern_negated_reference_is_rejected() {
        let cwd = Path::new("/repo");
        let nodes = HashMap::from([(
            "@utils".to_string(),
            vec!["src/utils/**/*".to_string(), "!@spec:tests".to_string()],
        )]);
        let graphs = HashMap::from([("default".to_string(), GraphSpec::default())]);
        let err = build_graph(cwd, &nodes, &graphs, vec![], "test").expect_err("should fail");
        assert!(err.contains("must not reference other nodes"));
    }
}
