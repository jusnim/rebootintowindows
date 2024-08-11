NAME=rebootintoWindows
DOMAIN=nimz.cool
BRANCH=$(shell git rev-parse --abbrev-ref HEAD)

.PHONY: all pack install clean

all: dist/extension.js

node_modules: package.json
	npm install

dist/extension.js: node_modules
	@ ./node_modules/typescript/bin/tsc

compile-po: po/*.po
	@for file in po/*.po; do \
		mkdir -p dist/locale/$$(basename $$file .po)/LC_MESSAGES; \
		msgfmt -o dist/locale/$$(basename $$file .po)/LC_MESSAGES/$(NAME)@$(DOMAIN).mo $$file; \
	done

$(NAME)@$(DOMAIN).zip: dist/extension.js
	@cp src/metadata.json dist/
	@$(MAKE) compile-po
	@(cd dist && zip ../$(NAME)@$(DOMAIN)-$(shell date +%Y%m%d)$(if $(filter dev,$(BRANCH)),-$(BRANCH)).zip -9r .)

pack: $(NAME)@$(DOMAIN).zip

install: $(NAME)@$(DOMAIN).zip
	@mkdir -p ~/.local/share/gnome-shell/extensions
	@FILE="$$(ls -t $(NAME)@$(DOMAIN)-*.zip 2>/dev/null | head -n 1)"; \
	if [ -n "$$FILE" ]; then \
		echo "Installing via CLI: $$FILE"; \
		gnome-extensions install "$$FILE" --force || ( \
			echo "CLI install failed, falling back to manual move..."; \
			rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN); \
			mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN); \
		); \
	fi

clean:
	@rm -rf dist node_modules $(NAME)@$(DOMAIN)-*.zip