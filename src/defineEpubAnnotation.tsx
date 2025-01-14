import * as genericAnnotation from 'defineGenericAnnotation';
import React from 'react';

import { AnnotatorSettings } from 'settings';
import { EpubAnnotationProps } from './types';

import * as epubjs from 'epubjs';
import { SpineItem } from 'epubjs/types/section';
import { PackagingMetadataObject } from 'epubjs/types/packaging';
import Navigation from 'epubjs/types/navigation';

import { wait } from 'utils';
import { SAMPLE_EPUB_URL } from './constants';

export default ({ vault, plugin }) => {
    const GenericAnnotationEpub = genericAnnotation.default({ vault, plugin });
    const EpubAnnotation = ({ ...props }: EpubAnnotationProps) => {
        return (
            <GenericAnnotationEpub
                baseSrc="https://cdn.hypothes.is/demos/epub/epub.js/index.html"
                {...props}
                onload={async iframe => {
                    await props.onload?.(iframe);
                    while (iframe?.contentDocument?.body?.innerHTML == '') {
                        await wait(50);
                    }

                    const epubReader = new EpubReader(plugin.settings.epubSettings, props, vault);
                    iframe.contentDocument.addEventListener('DOMContentLoaded', epubReader.start(iframe), false);
                }}
            />
        );
    };
    return EpubAnnotation;
};

class EpubReader {
    readonly bookUrl: string;
    readonly settings: AnnotatorSettings['epubSettings'];
    readonly readingModes = {
        scroll: { manager: 'continuous', flow: 'scrolled' },
        pagination: { manager: 'default', flow: 'paginated' }
    };

    constructor(epubSettings: AnnotatorSettings['epubSettings'], props: EpubAnnotationProps, vault: any) {
        this.bookUrl = SAMPLE_EPUB_URL;
        this.settings = epubSettings;
    }

    start(iframe: HTMLIFrameElement): any {
        const id = iframe.contentDocument;
        const iw = iframe.contentWindow;

        const book = this.initBook(id, iw);

        this.configureNavigationEvents(book, id, this.settings.readingMode);
        this.addBookMetaToUI(book, iframe);
        book.rendition.on('rendered', (section: SpineItem) => this.renderedHook(book, id, section));

        book.rendition.display();
        book.ready.then(() => this.removeLoader(id));
    }

    initBook(id: Document, iw: Window): epubjs.Book {
        const book = new epubjs.Book(this.bookUrl, {
            requestMethod: async function(url) {
                return await (await iw.fetch(url)).arrayBuffer();
            },
            canonical: function (path) {
                return iw.location.origin + iw.location.pathname + '?loc=' + path;
            }
        });

        book.renderTo(id.getElementById('viewer'), {
            ...this.readingModes[this.settings.readingMode],
            ignoreClass: 'annotator-hl',
            width: '100%',
            height: '100%',
            allowScriptedContent: true
        });

        book.rendition.themes.fontSize(`${this.settings.fontSize}%`);
        book.rendition.on('relocated', (_: any) => {
            book.rendition.themes.fontSize(`${this.settings.fontSize}%`);
        });

        (iw as any).rendition = book.rendition;
        return book;
    }

    renderedHook(book: epubjs.Book, id: Document, section: SpineItem) {
        const current = book.navigation && book.navigation.get(section.href);

        if (current) {
            id.title = current.label;

            // TODO: this is needed to trigger the hypothesis client
            // to inject into the iframe
            requestAnimationFrame(function () {
                id.getElementById('hiddenTitle').textContent = section.href;
            });

            // Add CFI fragment to the history
            history.pushState({}, '', '?loc=' + encodeURIComponent(section.href));

            id.querySelectorAll('.active').forEach(function (link) {
                link.classList.remove('active');
            });

            const active = id.querySelector('a[href="' + section.href + '"]');
            if (active) {
                active.classList.add('active');
            }
        }
    }

    addBookMetaToUI(book: epubjs.Book, iframe: HTMLIFrameElement) {
        // add chapters to table of contents
        book.loaded.navigation.then((nav: Navigation) => {
            const toc = iframe.contentDocument.getElementById('toc'),
                docfrag = iframe.contentDocument.createDocumentFragment();

            nav.forEach((chapter: epubjs.NavItem): any => {
                const item = iframe.contentDocument.createElement('li');
                const link = iframe.contentDocument.createElement('a');

                link.id = 'chap-' + chapter.id;
                link.textContent = chapter.label;
                link.href = chapter.href;
                item.appendChild(link);
                docfrag.appendChild(item);

                link.onclick = () => {
                    const url = link.getAttribute('href');
                    book.rendition.display(url);
                    return false;
                };
            });

            toc.appendChild(docfrag);
        });

        // add title and author to table of contents
        book.loaded.metadata.then(function (meta: PackagingMetadataObject) {
            iframe.contentDocument.getElementById('title').textContent = meta.title;
            iframe.contentDocument.getElementById('author').textContent = meta.creator;
        });

        // add cover to table of contents
        book.loaded.cover.then((cover: string) => {
            const coverImgEl = iframe.contentDocument.getElementById('cover') as HTMLImageElement;

            if (cover) {
                if (book.archive) {
                    book.archive.createUrl(cover, { base64: false }).then(url => {
                        coverImgEl.src = url;
                    });
                } else {
                    coverImgEl.src = cover;
                }
            }
        });

        book.rendition.hooks.content.register(function (contents: epubjs.Contents) {
            contents.window.addEventListener('scrolltorange', function (e: any) {
                const range = e.detail;
                const cfi = new epubjs.EpubCFI(range, contents.cfiBase).toString();

                if (cfi) {
                    book.rendition.display(cfi);
                }
                e.preventDefault();
            });
        });
    }

    configureNavigationEvents(book: epubjs.Book, id: Document, readingMode: 'scroll' | 'pagination') {
        // configure UI arrows
        if (readingMode == 'scroll') {
            id.querySelectorAll('a.arrow').forEach((e: HTMLElement) => (e.style.display = 'none'));
            id.querySelector('#viewer').classList.add('hide-after');
        }

        id.getElementById('next').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.next();
                e.preventDefault();
            },
            false
        );

        id.getElementById('prev').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.prev();
                e.preventDefault();
            },
            false
        );

        // turn pages by arrow buttons
        const keyListener = function (e: KeyboardEvent) {
            // Left Key
            if ((e.keyCode || e.which) == 37) {
                book.rendition.prev();
            }

            // Right Key
            if ((e.keyCode || e.which) == 39) {
                book.rendition.next();
            }
        };

        book.rendition.on('keyup', keyListener);
        id.addEventListener('keyup', keyListener, false);
        // to make keys work even when focus outside of reader iframe
        document.addEventListener('keyup', keyListener, false);

        // open/close table of contents
        const nav = id.getElementById('navigation');

        id.getElementById('opener').addEventListener(
            'click',
            function (_) {
                nav.classList.add('open');
            },
            false
        );

        id.getElementById('closer').addEventListener(
            'click',
            function (_) {
                nav.classList.remove('open');
            },
            false
        );
    }

    removeLoader = (id: Document) => {
        id.getElementById('viewer').classList.remove('loading');
    };
}
