defmodule SymphonyElixir.Linear.AgentTool do
  @moduledoc """
  Provider-native Linear tools exposed to Codex app-server turns.

  FORK NOTE (flue-agent-org integration): this is openai/symphony's
  `elixir/lib/symphony_elixir/linear/agent_tool.ex` with one addition —
  `delegate_to_flue_agent` — alongside the upstream `linear_graphql` tool.
  Diff against upstream is isolated to:
    - @delegate_to_flue_agent_tool / @delegate_to_flue_agent_description /
      @delegate_to_flue_agent_input_schema (new)
    - execute/3: one new case clause
    - tool_specs/0: one new entry in the list
    - execute_delegate_to_flue_agent/2, dispatch_url/0,
      build_dispatch_payload/1, dispatch_http_client/0 (new, private)
  Every other function is byte-for-byte upstream — see the original at
  https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/linear/agent_tool.ex

  Because `Tracker.bind_agent_tools/0` binds one adapter's *entire*
  `agent_tool_specs()` list for the session (see SPEC.md §10.5: "Tool specs,
  adapter selection, and effective tracker settings MUST be bound to one
  session snapshot"), a new tool for the Linear tracker has to live inside
  this module — Symphony has no separate "register an extra tool" hook.
  """

  alias SymphonyElixir.Linear.Client

  @linear_graphql_tool "linear_graphql"
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  # --- flue-agent-org addition -------------------------------------------

  @delegate_to_flue_agent_tool "delegate_to_flue_agent"
  @delegate_to_flue_agent_description """
  Hand this issue off to the specialist Flue agent selected by the issue's
  `role/*` label (deterministic label -> role-id lookup, not a model guess).
  Use this once at the start of a turn instead of attempting the work
  yourself when the issue carries a `role/*` label you were not specifically
  told to handle directly. Returns the specialist agent's output and
  confidence score; the calling agent decides how to use it (e.g. post it as
  a Linear comment, open a PR from it, or escalate if confidence is low).
  """
  @delegate_to_flue_agent_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => [],
    "properties" => %{
      "note" => %{
        "type" => ["string", "null"],
        "description" => "Optional extra context to append to the issue description before delegating."
      }
    }
  }

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts) do
    case tool do
      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      @delegate_to_flue_agent_tool ->
        execute_delegate_to_flue_agent(arguments, opts)

      other ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(other)}.",
            "supportedTools" => supported_tool_names()
          }
        })
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => @linear_graphql_tool,
        "description" => @linear_graphql_description,
        "inputSchema" => @linear_graphql_input_schema
      },
      %{
        "name" => @delegate_to_flue_agent_tool,
        "description" => @delegate_to_flue_agent_description,
        "inputSchema" => @delegate_to_flue_agent_input_schema
      }
    ]
  end

  # --- flue-agent-org addition: delegate_to_flue_agent --------------------

  defp execute_delegate_to_flue_agent(arguments, opts) do
    issue = Keyword.get(opts, :issue)

    note =
      case arguments do
        %{"note" => note} when is_binary(note) -> note
        _ -> nil
      end

    with {:ok, issue} <- require_issue(issue),
         payload <- build_dispatch_payload(issue, note),
         {:ok, response} <- post_dispatch(payload) do
      dispatch_success_response(response)
    else
      {:error, reason} -> failure_response(dispatch_error_payload(reason))
    end
  end

  defp require_issue(%SymphonyElixir.Tracker.Issue{} = issue), do: {:ok, issue}
  defp require_issue(_), do: {:error, :missing_issue_context}

  defp build_dispatch_payload(issue, note) do
    %{
      "issue" => %{
        "identifier" => issue.identifier,
        "title" => issue.title,
        "description" => Enum.join(Enum.filter([issue.description, note], & &1), "\n\n"),
        "url" => issue.url,
        "labels" => issue.labels
      }
    }
  end

  defp post_dispatch(payload) do
    dispatch_http_client().(dispatch_url(), payload)
  end

  # Real network call by default: POST to the local Node bridge
  # (server/dispatch.mjs in flue-agent-org) that resolves the role/* label
  # and runs the matching Flue agent from registry.ts. Injectable for tests
  # via Application.put_env(:symphony_elixir, :flue_dispatch_client, fun).
  defp dispatch_http_client do
    Application.get_env(:symphony_elixir, :flue_dispatch_client, fn url, payload ->
      case Req.post(url, json: payload, receive_timeout: 120_000) do
        {:ok, %{status: 200, body: body}} -> {:ok, body}
        {:ok, %{status: status, body: body}} -> {:error, {:dispatch_http_status, status, body}}
        {:error, reason} -> {:error, {:dispatch_request_failed, reason}}
      end
    end)
  end

  defp dispatch_url do
    # 4001, not 4000: 4000 is the example dashboard port used throughout
    # Symphony's own test fixtures (test/symphony_elixir/orchestrator_status_test.exs),
    # so it's the port a dev is likely to reach for if they set
    # `server.port` in their own WORKFLOW.md. Not a hardcoded default
    # collision (the dashboard has no default port and won't start unless
    # `server.port` is configured), but a likely convention collision.
    Application.get_env(:symphony_elixir, :flue_dispatch_url, "http://127.0.0.1:4001/dispatch")
  end

  defp dispatch_success_response(%{"error" => _} = body) do
    failure_response(body)
  end

  defp dispatch_success_response(body) when is_map(body) do
    dynamic_tool_response(true, encode_payload(body))
  end

  defp dispatch_error_payload(:missing_issue_context) do
    %{
      "error" => %{
        "message" => "delegate_to_flue_agent has no issue in scope for this turn (internal binding error)."
      }
    }
  end

  defp dispatch_error_payload({:dispatch_http_status, 422, body}) do
    %{
      "error" => %{
        "message" =>
          "flue-agent-org dispatch bridge could not route this issue to a role " <>
            "(no matching or ambiguous role/* label). Ask a human to add the correct label.",
        "detail" => body
      }
    }
  end

  defp dispatch_error_payload({:dispatch_http_status, status, body}) do
    %{
      "error" => %{
        "message" => "flue-agent-org dispatch bridge returned HTTP #{status}.",
        "detail" => body
      }
    }
  end

  defp dispatch_error_payload({:dispatch_request_failed, reason}) do
    %{
      "error" => %{
        "message" => "Could not reach the flue-agent-org dispatch bridge. Is `node server/dispatch.mjs` running?",
        "reason" => inspect(reason)
      }
    }
  end

  # --- upstream, unchanged --------------------------------------------------

  defp execute_linear_graphql(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)
    client_opts = Keyword.take(opts, [:tracker_settings])

    with {:ok, query, variables} <- normalize_linear_graphql_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, client_opts) do
      graphql_response(response)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    case normalize_query(arguments) do
      {:ok, query} ->
        case normalize_variables(arguments) do
          {:ok, variables} ->
            {:ok, query, variables}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_response(response) do
    success =
      case response do
        %{"errors" => errors} when is_list(errors) and errors != [] -> false
        %{errors: errors} when is_list(errors) and errors != [] -> false
        _ -> true
      end

    dynamic_tool_response(success, encode_payload(response))
  end

  defp failure_response(payload) do
    dynamic_tool_response(false, encode_payload(payload))
  end

  defp dynamic_tool_response(success, output) when is_boolean(success) and is_binary(output) do
    %{
      "success" => success,
      "output" => output,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => output
        }
      ]
    }
  end

  defp encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  defp encode_payload(payload), do: inspect(payload)

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `tracker.provider.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp supported_tool_names do
    Enum.map(tool_specs(), & &1["name"])
  end
end
