import { flatten, getFormData, getValidationMessage } from './formdata.js';
import {
	isFieldElement,
	getFormAction,
	getFormEncType,
	getFormMethod,
	focusFirstInvalidField,
} from './dom.js';
import type {
	FormMetadata,
	Submission,
	SubmissionContext,
	SubmissionResult,
	DefaultValue,
	FormState,
	Constraint,
} from './types.js';
import { invariant } from './util.js';
import { requestIntent, validate } from './intent.js';

export interface FormContext {
	metadata: FormMetadata;
	initialValue: Record<string, unknown>;
	error: Record<string, string[]>;
	state: FormState;
}

export interface FormOptions<Type> {
	defaultValue?: DefaultValue<Type>;
	constraint?: Record<string, Constraint>;
	lastResult?: SubmissionResult;
	shouldValidate?: 'onSubmit' | 'onBlur' | 'onInput';
	shouldRevalidate?: 'onSubmit' | 'onBlur' | 'onInput';
	onValidate?: (context: SubmissionContext) => Submission<Type>;
}

export type SubscriptionSubject = {
	[key in 'error' | 'defaultValue' | 'key' | 'validated']?:
		| boolean
		| Record<string, boolean>;
};

export interface Form<Type extends Record<string, unknown> = any> {
	id: string;
	submit(event: SubmitEvent): void;
	reset(event: Event): void;
	input(event: Event): void;
	blur(event: Event): void;
	report(result: SubmissionResult): void;
	update(options: Omit<FormOptions<Type>, 'lastResult'>): void;
	subscribe(
		callback: () => void,
		getSubject?: () => SubscriptionSubject | undefined,
	): () => void;
	getContext(): FormContext;
}

export function createForm<Type extends Record<string, unknown> = any>(
	formId: string,
	options: FormOptions<Type>,
): Form<Type> {
	const metadata: FormMetadata = initializeMetadata(options);

	let subscribers: Array<{
		callback: () => void;
		getSubject: () => SubscriptionSubject;
	}> = [];
	let latestOptions = options;
	let context: FormContext = {
		metadata,
		initialValue: options.lastResult?.initialValue ?? metadata.defaultValue,
		error: options.lastResult?.error ?? {},
		state: options.lastResult?.state ?? {
			validated: {},
			listKeys: {},
		},
	};

	function getFormElement(): HTMLFormElement {
		const element = document.forms.namedItem(formId);
		invariant(element !== null, `Form#${formId} does not exist`);
		return element;
	}

	function initializeMetadata(options: FormOptions<Type>): FormMetadata {
		return {
			defaultValue: flatten(options.defaultValue),
			constraint: options.constraint ?? {},
		};
	}

	function shouldNotify<Type>(options: {
		prev: Record<string, Type>;
		next: Record<string, Type>;
		compareFn: (prev: Type | undefined, next: Type | undefined) => boolean;
		cache: Record<string, boolean>;
		scope: true | Record<string, boolean>;
	}): boolean {
		const names =
			typeof options.scope !== 'boolean'
				? Object.keys(options.scope)
				: [...Object.keys(options.prev), ...Object.keys(options.next)];

		for (const name of names) {
			options.cache[name] ??= options.compareFn(
				options.prev[name],
				options.next[name],
			);

			if (options.cache[name]) {
				return true;
			}
		}

		return false;
	}

	function updateContext(next: FormContext) {
		const diff: Record<keyof SubscriptionSubject, Record<string, boolean>> = {
			error: {},
			defaultValue: {},
			key: {},
			validated: {},
		};
		const prev = context;

		// Apply change before notifying subscribers
		context = next;

		for (const subscriber of subscribers) {
			const subject = subscriber.getSubject();

			if (
				(subject.error &&
					shouldNotify({
						prev: prev.error,
						next: next.error,
						compareFn: (prev, next) =>
							getValidationMessage(prev) !== getValidationMessage(next),
						cache: diff.error,
						scope: subject.error,
					})) ||
				(subject.key &&
					shouldNotify({
						prev: prev.state.listKeys,
						next: next.state.listKeys,
						compareFn: (prev, next) =>
							getValidationMessage(prev) !== getValidationMessage(next),
						cache: diff.key,
						scope: subject.key,
					})) ||
				(subject.defaultValue &&
					shouldNotify({
						prev: prev.metadata.defaultValue,
						next: next.metadata.defaultValue,
						compareFn: (prev, next) => prev !== next,
						cache: diff.defaultValue,
						scope: subject.defaultValue,
					})) ||
				(subject.validated &&
					shouldNotify({
						prev: prev.state.validated,
						next: next.state.validated,
						compareFn: (prev, next) => (prev ?? false) !== (next ?? false),
						cache: diff.validated,
						scope: subject.validated,
					}))
			) {
				subscriber.callback();
			}
		}
	}

	function submit(event: SubmitEvent): {
		formData: FormData;
		action: ReturnType<typeof getFormAction>;
		encType: ReturnType<typeof getFormEncType>;
		method: ReturnType<typeof getFormMethod>;
		submission?: Submission<Type>;
	} {
		const element = event.target as HTMLFormElement;
		const submitter = event.submitter as
			| HTMLButtonElement
			| HTMLInputElement
			| null;

		invariant(
			element === getFormElement(),
			`The submit event is dispatched by form#${element.id} instead of form#${formId}`,
		);

		const formData = getFormData(element, submitter);
		const result = {
			formData,
			action: getFormAction(event),
			encType: getFormEncType(event),
			method: getFormMethod(event),
		};

		if (typeof latestOptions?.onValidate !== 'undefined') {
			try {
				const submission = latestOptions.onValidate({
					form: element,
					formData,
					submitter,
				});

				if (!submission.ready) {
					const result = submission.reject();

					if (
						result.error &&
						Object.values(result.error).every(
							(messages) => !messages.includes('__VALIDATION_UNDEFINED__'),
						)
					) {
						report(result);
						event.preventDefault();
					}
				}

				return {
					...result,
					submission,
				};
			} catch (error) {
				// eslint-disable-next-line no-console
				console.warn('Client validation failed', error);
			}
		}

		return result;
	}

	function validateField(eventName: string, event: Event): void {
		const form = getFormElement();
		const element = event.target;

		if (
			!isFieldElement(element) ||
			element.form !== form ||
			element.name === '' ||
			event.defaultPrevented
		) {
			return;
		}

		const { shouldValidate = 'onSubmit', shouldRevalidate = shouldValidate } =
			latestOptions;
		const validated = context.state.validated[element.name];

		if (
			validated ? shouldRevalidate === eventName : shouldValidate === eventName
		) {
			requestIntent(form, {
				value: validate.serialize(element.name),
				formNoValidate: true,
			});
		}
	}

	function reset(event: Event) {
		const element = getFormElement();

		if (
			event.type !== 'reset' ||
			event.target !== element ||
			event.defaultPrevented
		) {
			return;
		}

		const metadata = initializeMetadata(latestOptions);

		updateContext({
			metadata,
			initialValue: metadata.defaultValue,
			error: {},
			state: {
				validated: {},
				listKeys: {},
			},
		});
	}

	function report(result: SubmissionResult) {
		const formElement = getFormElement();

		if (typeof result.initialValue === 'undefined') {
			formElement.reset();
			return;
		}

		updateContext({
			metadata: context.metadata,
			initialValue: result.initialValue,
			error: result.error ?? {},
			state: result.state ?? {
				validated: {},
				listKeys: {},
			},
		});

		for (const element of formElement.elements) {
			if (isFieldElement(element) && element.name !== '') {
				element.setCustomValidity(
					context.error[element.name]?.join(', ') ?? '',
				);
			}
		}

		if (result.status === 'failed') {
			// Update focus
			focusFirstInvalidField(formElement);
		}
	}

	function update(options: Omit<FormOptions<Type>, 'lastResult'>) {
		latestOptions = options;
	}

	function subscribe(
		callback: () => void,
		getSubject?: () => SubscriptionSubject | undefined,
	) {
		const subscriber = {
			callback,
			getSubject: () => getSubject?.() ?? {},
		};

		subscribers.push(subscriber);

		return () => {
			subscribers = subscribers.filter((current) => current !== subscriber);
		};
	}

	function getContext(): FormContext {
		return context;
	}

	return {
		id: formId,
		submit,
		reset,
		input: validateField.bind(null, 'onInput'),
		blur: validateField.bind(null, 'onBlur'),
		report,
		update,
		subscribe,
		getContext,
	};
}
