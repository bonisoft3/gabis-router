// Mirror-only module declaration. Copybara stages this file from
// .mirror/cue.mod/ to the bonisoft3/gabis-router root as
// cue.mod/module.cue. In the monorepo gabis-router's CUE resolves against the
// root cue.mod (bonisoft.org), which is HEAD; copybara rewrites its imports
// to github.com/bonisoft3/*, and the mirror resolves them from the Central
// Registry at the versions below, the ones .mise.toml installs.
module: "github.com/bonisoft3/gabis-router@v0"

language: {
	version: "v0.18.0"
}

source: {
	kind: "git"
}

deps: {
	"github.com/bonisoft3/bayt@v0": {
		v:       "v0.73.2"
		default: true
	}
	"github.com/bonisoft3/mecha@v0": {
		v:       "v0.35.1"
		default: true
	}
	"github.com/bonisoft3/omnishell@v0": {
		v:       "v0.35.0"
		default: true
	}
	"github.com/bonisoft3/pronto@v1": {
		v:       "v1.15.1"
		default: true
	}
	"github.com/bonisoft3/sayt@v0": {
		v:       "v0.49.2"
		default: true
	}
}
